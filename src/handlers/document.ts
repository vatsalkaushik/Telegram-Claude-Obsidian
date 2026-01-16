/**
 * Document handler for Obsidian Telegram Assistant.
 *
 * Stores documents in Attachments/ and appends a link to the daily note.
 */

import type { Context } from "grammy";
import { mkdir } from "fs/promises";
import { extname, join, relative } from "path";
import { ALLOWED_USERS, ATTACHMENTS_DIR, VAULT_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit } from "../utils";
import { createMediaGroupBuffer } from "./media-group";
import { appendDailyEntry, getDateTimeInfo } from "../vault";

const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024;

type DocumentItem = {
  fullPath: string;
  relativePath: string;
  name: string;
  mimeType?: string;
};

const documentBuffer = createMediaGroupBuffer<DocumentItem>({
  emoji: "📄",
  itemLabel: "document",
  itemLabelPlural: "documents",
});

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function buildDocumentPath(fileName: string): Promise<DocumentItem> {
  const { dateStamp, timeStamp, monthStamp } = await getDateTimeInfo();
  const safeTime = timeStamp.replace(":", "");
  const safeName = sanitizeFileName(fileName || "document");
  const ext = extname(safeName);
  const base = ext ? safeName.slice(0, -ext.length) : safeName;
  const finalName = `${base}-${dateStamp}-${safeTime}${ext}`;

  const dir = join(ATTACHMENTS_DIR, monthStamp);
  await mkdir(dir, { recursive: true });

  const fullPath = join(dir, finalName);
  const relativePath = relative(VAULT_DIR, fullPath);

  return {
    fullPath,
    relativePath,
    name: fileName || finalName,
  };
}

async function downloadDocument(ctx: Context): Promise<DocumentItem> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const file = await ctx.getFile();
  const target = await buildDocumentPath(doc.file_name || "document");

  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(target.fullPath, buffer);

  return { ...target, mimeType: doc.mime_type };
}

async function extractText(
  filePath: string,
  mimeType?: string
): Promise<string> {
  const extension = "." + (filePath.split(".").pop() || "").toLowerCase();

  if (mimeType === "application/pdf" || extension === ".pdf") {
    try {
      const result = await Bun.$`pdftotext -layout ${filePath} -`.quiet();
      return result.text();
    } catch (error) {
      console.error("PDF parsing failed:", error);
      return "";
    }
  }

  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    return text.slice(0, 100000);
  }

  return "";
}

function formatExcerpt(text: string, limit = 1000): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const snippet = trimmed.slice(0, limit);
  const lines = snippet.split(/\r?\n/).filter((line) => line.trim());
  return lines.map((line) => `> ${line}`).join("\n");
}

async function processDocuments(
  ctx: Context,
  documents: DocumentItem[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  void chatId;
  try {
    let entry: string;
    if (documents.length === 1) {
      const doc = documents[0];
      if (!doc) {
        await ctx.reply("❌ Failed to process document.");
        return;
      }
      const link = `[[${doc.relativePath}]]`;
      const excerpt = await extractText(doc.fullPath, doc.mimeType);
      const formattedExcerpt = formatExcerpt(excerpt);

      entry = caption ? `${link} ${caption}` : link;
      if (formattedExcerpt) {
        entry = `${entry}\n${formattedExcerpt}`;
      }
    } else {
      const links = documents.map((d) => `[[${d.relativePath}]]`).join(" ");
      entry = caption ? `${links} ${caption}` : links;
    }

    const { dateStamp, timeStamp } = await appendDailyEntry(entry);
    await auditLog(
      userId,
      username,
      "DOCUMENT",
      `${documents.length} document(s)`
    );
    await ctx.reply(`✅ Added to Daily/${dateStamp}.md (${timeStamp})`);
  } catch (error) {
    console.error("Error processing document:", error);
    await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
  }
}

export async function handleDocument(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId || !doc) {
    return;
  }

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("❌ File too large. Maximum size is 10MB.");
    return;
  }

  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isPdf = doc.mime_type === "application/pdf" || extension === ".pdf";
  const isText =
    TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");

  if (!isPdf && !isText) {
    await ctx.reply(
      `❌ Unsupported file type: ${extension || doc.mime_type}\n\n` +
        `Supported: PDF, ${TEXT_EXTENSIONS.join(", ")}`
    );
    return;
  }

  let docItem: DocumentItem;
  try {
    docItem = await downloadDocument(ctx);
  } catch (error) {
    console.error("Failed to download document:", error);
    await ctx.reply("❌ Failed to download document.");
    return;
  }

  if (!mediaGroupId) {
    console.log(`Received document: ${fileName} from @${username}`);
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    await processDocuments(
      ctx,
      [docItem],
      ctx.message?.caption,
      userId,
      username,
      chatId
    );
    return;
  }

  await documentBuffer.addToGroup(
    mediaGroupId,
    docItem,
    ctx,
    userId,
    username,
    processDocuments
  );
}
