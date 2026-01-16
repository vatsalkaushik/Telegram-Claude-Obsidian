/**
 * Photo message handler for Obsidian Telegram Assistant.
 *
 * Supports single photos and media groups (albums) with 1s buffering.
 */

import type { Context } from "grammy";
import { mkdir } from "fs/promises";
import { join, relative } from "path";
import { ALLOWED_USERS, ATTACHMENTS_DIR, VAULT_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit } from "../utils";
import { createMediaGroupBuffer } from "./media-group";
import { appendDailyEntry, getDateTimeInfo } from "../vault";

// Create photo-specific media group buffer
const photoBuffer = createMediaGroupBuffer({
  emoji: "📷",
  itemLabel: "photo",
  itemLabelPlural: "photos",
});

/**
 * Download a photo and return the local path.
 */
async function buildPhotoPath(): Promise<{
  fullPath: string;
  relativePath: string;
}> {
  const { dateStamp, timeStamp, monthStamp } = await getDateTimeInfo();
  const safeTime = timeStamp.replace(":", "");
  const suffix = Math.random().toString(36).slice(2, 8);
  const fileName = `photo-${dateStamp}-${safeTime}-${suffix}.jpg`;
  const dir = join(ATTACHMENTS_DIR, monthStamp);
  await mkdir(dir, { recursive: true });
  const fullPath = join(dir, fileName);
  const relativePath = relative(VAULT_DIR, fullPath);
  return { fullPath, relativePath };
}

async function downloadPhoto(ctx: Context): Promise<{
  fullPath: string;
  relativePath: string;
}> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    throw new Error("No photo in message");
  }

  // Get the largest photo
  const file = await ctx.getFile();
  const { fullPath, relativePath } = await buildPhotoPath();

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(fullPath, buffer);

  return { fullPath, relativePath };
}

/**
 * Process photos and append to daily note.
 */
async function processPhotos(
  ctx: Context,
  photoPaths: Array<{ fullPath: string; relativePath: string }>,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  void chatId;
  try {
    const embeds = photoPaths
      .map((p) => `![[${p.relativePath}]]`)
      .join(" ");
    const entry = caption ? `${embeds} ${caption}` : embeds;

    const { dateStamp, timeStamp } = await appendDailyEntry(entry);
    await auditLog(userId, username, "PHOTO", entry);
    await ctx.reply(`✅ Added to Daily/${dateStamp}.md (${timeStamp})`);
  } catch (error) {
    console.error("Error processing photo:", error);
    await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
  }
}

/**
 * Handle incoming photo messages.
 */
export async function handlePhoto(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. For single photos, show status and rate limit early
  let statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;
  if (!mediaGroupId) {
    console.log(`Received photo from @${username}`);
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    // Show status immediately
    statusMsg = await ctx.reply("📷 Processing image...");
  }

  // 3. Download photo
  let photoPath: { fullPath: string; relativePath: string };
  try {
    photoPath = await downloadPhoto(ctx);
  } catch (error) {
    console.error("Failed to download photo:", error);
    if (statusMsg) {
      try {
        await ctx.api.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          "❌ Failed to download photo."
        );
      } catch (editError) {
        console.debug("Failed to edit status message:", editError);
        await ctx.reply("❌ Failed to download photo.");
      }
    } else {
      await ctx.reply("❌ Failed to download photo.");
    }
    return;
  }

  // 4. Single photo - process immediately
  if (!mediaGroupId && statusMsg) {
    await processPhotos(
      ctx,
      [photoPath],
      ctx.message?.caption,
      userId,
      username,
      chatId
    );

    // Clean up status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch (error) {
      console.debug("Failed to delete status message:", error);
    }
    return;
  }

  // 5. Media group - buffer with timeout
  if (!mediaGroupId) return; // TypeScript guard

  await photoBuffer.addToGroup(
    mediaGroupId,
    photoPath,
    ctx,
    userId,
    username,
    processPhotos
  );
}
