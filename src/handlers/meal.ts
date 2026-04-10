/**
 * Meal capture and correction handlers.
 */

import type { Context } from "grammy";
import { join } from "path";
import {
  ALLOWED_USERS,
  MEAL_ANALYSIS_AVAILABLE,
  VAULT_DIR,
} from "../config";
import { escapeHtml } from "../formatting";
import { analyzeMeal } from "../meals/analysis";
import { addMealEntry, getMealEntry, updateMealEntry } from "../meals/storage";
import type { MealEntry, MealPhoto } from "../meals/types";
import { registerMealReplyTargets } from "../reply-routes";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { getDateTimeInfoForDate } from "../vault";

type PendingMealStatusMessage = {
  chatId: number;
  messageId: number;
};

type PendingMealJob = {
  id: string;
  ctx: Context;
  userId: number;
  username: string;
  note: string;
  noteVersion: number;
  photos: MealPhoto[];
  capturedAt: Date;
  sourceMessageIds: number[];
  statusMessage?: PendingMealStatusMessage;
  completed: boolean;
};

const pendingMealReplyRoutes = new Map<number, PendingMealJob>();

function formatMacro(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function buildMealSummary(entry: MealEntry, updated = false): string {
  const header = updated ? "🔄 <b>Meal updated</b>" : "🍽️ <b>Meal logged</b>";
  const lines = [
    `${header}\n<b>${escapeHtml(entry.analysis.mealType)}</b> • <code>${escapeHtml(
      entry.timeStamp
    )}</code>`,
    escapeHtml(entry.analysis.items.join(", ")),
    `Cal: ${Math.round(entry.analysis.calories)} | P: ${formatMacro(
      entry.analysis.protein
    )}g | C: ${formatMacro(entry.analysis.carbs)}g | F: ${formatMacro(
      entry.analysis.fat
    )}g | Fiber: ${formatMacro(entry.analysis.fiber)}g`,
    `Confidence: ${escapeHtml(entry.analysis.confidence)}`,
  ];

  if (entry.userNote) {
    lines.push(`Note: ${escapeHtml(entry.userNote)}`);
  }

  if (updated && entry.correctionHistory.length > 0) {
    const latestCorrection =
      entry.correctionHistory[entry.correctionHistory.length - 1];
    if (latestCorrection) {
      lines.push(`Correction: ${escapeHtml(latestCorrection.text)}`);
    }
  }

  lines.push("Reply to correct.");
  return lines.join("\n");
}

function getMessageDate(ctx: Context): Date {
  const timestamp = ctx.message?.date;
  if (typeof timestamp === "number") {
    return new Date(timestamp * 1000);
  }
  return new Date();
}

function mergeMealNotes(existing: string, extra: string): string {
  const trimmedExisting = existing.trim();
  const trimmedExtra = extra.trim();

  if (!trimmedExisting) {
    return trimmedExtra;
  }
  if (!trimmedExtra) {
    return trimmedExisting;
  }

  return `${trimmedExisting}\n${trimmedExtra}`;
}

function registerPendingMealReplyTargets(job: PendingMealJob): void {
  for (const messageId of job.sourceMessageIds) {
    pendingMealReplyRoutes.set(messageId, job);
  }

  if (job.statusMessage) {
    pendingMealReplyRoutes.set(job.statusMessage.messageId, job);
  }
}

function clearPendingMealReplyTargets(job: PendingMealJob): void {
  for (const [messageId, candidate] of pendingMealReplyRoutes.entries()) {
    if (candidate.id === job.id) {
      pendingMealReplyRoutes.delete(messageId);
    }
  }
}

async function updatePendingStatus(
  ctx: Context,
  statusMessage: PendingMealStatusMessage | undefined,
  text: string
): Promise<void> {
  if (!statusMessage) {
    return;
  }

  try {
    await ctx.api.editMessageText(statusMessage.chatId, statusMessage.messageId, text);
  } catch {
    // Ignore status edit failures.
  }
}

async function removePendingStatus(
  ctx: Context,
  statusMessage: PendingMealStatusMessage | undefined
): Promise<void> {
  if (!statusMessage) {
    return;
  }

  try {
    await ctx.api.deleteMessage(statusMessage.chatId, statusMessage.messageId);
  } catch {
    // Ignore status cleanup failures.
  }
}

async function checkMealAccess(ctx: Context): Promise<{
  userId: number;
  username: string;
} | null> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return null;
  }

  if (!MEAL_ANALYSIS_AVAILABLE) {
    await ctx.reply("Meal analysis is not configured. Set OPENAI_API_KEY in .env");
    return null;
  }

  if (!userId) {
    return null;
  }

  return { userId, username };
}

async function checkMealRateLimit(
  ctx: Context,
  userId: number,
  username: string
): Promise<boolean> {
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (allowed) {
    return true;
  }

  await auditLogRateLimit(userId, username, retryAfter!);
  await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
  return false;
}

async function sendMealSummary(
  ctx: Context,
  entry: MealEntry,
  updated = false,
  extraReplyTargetIds: number[] = []
): Promise<void> {
  const reply = await ctx.reply(buildMealSummary(entry, updated), {
    parse_mode: "HTML",
  });
  await registerMealReplyTargets(
    [reply.message_id, ...extraReplyTargetIds],
    entry.id,
    entry.dateStamp
  );
}

async function createMealEntry(
  note: string,
  photos: MealPhoto[],
  capturedAt: Date
): Promise<MealEntry> {
  const dateInfo = await getDateTimeInfoForDate(capturedAt);
  const analyzed = await analyzeMeal({
    note,
    photos,
    capturedAt: capturedAt.toISOString(),
    timeZone: dateInfo.timeZone,
  });

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    capturedAt: capturedAt.toISOString(),
    dateStamp: dateInfo.dateStamp,
    timeStamp: dateInfo.timeStamp,
    weekday: dateInfo.weekday,
    timeZone: dateInfo.timeZone,
    userNote: note,
    imagePaths: photos.map((photo) => photo.relativePath),
    imageFileIds: photos.map((photo) => photo.telegramFileId || "").filter(Boolean),
    analysis: analyzed.analysis,
    model: analyzed.model,
    createdAt: now,
    updatedAt: now,
    correctionHistory: [],
  };
}

async function finalizePendingMealJob(
  job: PendingMealJob,
  entry: MealEntry
): Promise<void> {
  await addMealEntry(entry);
  await removePendingStatus(job.ctx, job.statusMessage);
  await sendMealSummary(job.ctx, entry, false, job.sourceMessageIds);
  await auditLog(
    job.userId,
    job.username,
    "MEAL",
    entry.userNote || `${entry.imagePaths.length} meal photo(s)`
  );
}

async function runPendingMealJob(job: PendingMealJob): Promise<void> {
  while (!job.completed) {
    const noteVersion = job.noteVersion;

    try {
      const entry = await createMealEntry(job.note, job.photos, job.capturedAt);

      if (job.noteVersion !== noteVersion) {
        await updatePendingStatus(
          job.ctx,
          job.statusMessage,
          "🍽️ Added your note. Re-analyzing meal..."
        );
        continue;
      }

      job.completed = true;
      clearPendingMealReplyTargets(job);
      await finalizePendingMealJob(job, entry);
      return;
    } catch (error) {
      if (job.noteVersion !== noteVersion) {
        await updatePendingStatus(
          job.ctx,
          job.statusMessage,
          "🍽️ Added your note. Re-analyzing meal..."
        );
        continue;
      }

      job.completed = true;
      clearPendingMealReplyTargets(job);
      console.error("Pending meal analysis failed:", error);
      await updatePendingStatus(
        job.ctx,
        job.statusMessage,
        `❌ ${String(error).slice(0, 200)}`
      );
      if (!job.statusMessage) {
        await job.ctx.reply(`❌ ${String(error).slice(0, 200)}`);
      }
      return;
    }
  }
}

export function extractMealCommandText(text: string | undefined): string | null {
  if (!text) {
    return null;
  }

  const match = text.trim().match(/^\/meal(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }

  return (match[1] || "").trim();
}

export async function tryMergePendingMealReply(
  ctx: Context,
  replyToMessageId: number,
  noteText: string
): Promise<boolean> {
  const job = pendingMealReplyRoutes.get(replyToMessageId);
  if (!job || job.completed) {
    return false;
  }

  const trimmedNote = noteText.trim();
  if (!trimmedNote) {
    return true;
  }

  job.note = mergeMealNotes(job.note, trimmedNote);
  job.noteVersion += 1;

  await updatePendingStatus(
    job.ctx,
    job.statusMessage,
    "🍽️ Added your note. Re-analyzing meal..."
  );
  await ctx.reply("📝 Added to the pending meal analysis.");
  return true;
}

export async function handleMealCommand(ctx: Context): Promise<void> {
  const access = await checkMealAccess(ctx);
  if (!access) {
    return;
  }

  const note =
    (ctx.match || "").toString().trim() ||
    extractMealCommandText(ctx.message?.text) ||
    "";
  if (!note) {
    await ctx.reply(
      "Use /meal <what you ate> for text-only meals, or add /meal in a photo caption."
    );
    return;
  }

  if (!(await checkMealRateLimit(ctx, access.userId, access.username))) {
    return;
  }

  const typing = startTypingIndicator(ctx);
  const status = await ctx.reply("🍽️ Analyzing meal...");

  try {
    const entry = await createMealEntry(note, [], getMessageDate(ctx));
    await addMealEntry(entry);
    await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    await sendMealSummary(
      ctx,
      entry,
      false,
      typeof ctx.message?.message_id === "number" ? [ctx.message.message_id] : []
    );
    await auditLog(access.userId, access.username, "MEAL", note);
  } catch (error) {
    console.error("Meal command failed:", error);
    await ctx.api
      .editMessageText(
        status.chat.id,
        status.message_id,
        `❌ ${String(error).slice(0, 200)}`
      )
      .catch(async () => {
        await ctx.reply(`❌ ${String(error).slice(0, 200)}`);
      });
  } finally {
    typing.stop();
  }
}

export async function handleMealPhotos(
  ctx: Context,
  photos: MealPhoto[],
  note: string,
  options: {
    skipRateLimit?: boolean;
    sourceMessageIds?: number[];
    statusMessage?: PendingMealStatusMessage;
  } = {}
): Promise<void> {
  const access = await checkMealAccess(ctx);
  if (!access) {
    await removePendingStatus(ctx, options.statusMessage);
    return;
  }

  if (
    !options.skipRateLimit &&
    !(await checkMealRateLimit(ctx, access.userId, access.username))
  ) {
    await removePendingStatus(ctx, options.statusMessage);
    return;
  }

  const statusMessage =
    options.statusMessage ||
    (await ctx
      .reply(
        note.trim()
          ? "🍽️ Analyzing meal..."
          : "🍽️ Analyzing meal... Reply now if you want to add details."
      )
      .then((message) => ({
        chatId: message.chat.id,
        messageId: message.message_id,
      })));

  const sourceMessageIds =
    options.sourceMessageIds && options.sourceMessageIds.length > 0
      ? options.sourceMessageIds
      : [];

  const job: PendingMealJob = {
    id: crypto.randomUUID(),
    ctx,
    userId: access.userId,
    username: access.username,
    note,
    noteVersion: 0,
    photos,
    capturedAt: getMessageDate(ctx),
    sourceMessageIds,
    statusMessage,
    completed: false,
  };

  registerPendingMealReplyTargets(job);
  void runPendingMealJob(job);
}

export async function handleMealCorrection(
  ctx: Context,
  correctionText: string,
  route: { mealId: string; dateStamp: string }
): Promise<void> {
  const access = await checkMealAccess(ctx);
  if (!access) {
    return;
  }

  if (!correctionText.trim()) {
    await ctx.reply("Please include the correction text.");
    return;
  }

  if (!(await checkMealRateLimit(ctx, access.userId, access.username))) {
    return;
  }

  const existing = await getMealEntry(route.dateStamp, route.mealId);
  if (!existing) {
    await ctx.reply("Could not find that meal entry anymore.");
    return;
  }

  const typing = startTypingIndicator(ctx);
  const status = await ctx.reply("🔄 Updating meal...");

  try {
    const photos = existing.imagePaths.map((relativePath) => ({
      relativePath,
      fullPath: join(VAULT_DIR, relativePath),
    }));

    const analyzed = await analyzeMeal({
      note: existing.userNote,
      photos,
      capturedAt: existing.capturedAt,
      timeZone: existing.timeZone,
      correctionText,
      priorAnalysis: existing.analysis,
    });

    const updated = await updateMealEntry(route.dateStamp, route.mealId, (meal) => ({
      ...meal,
      analysis: analyzed.analysis,
      model: analyzed.model,
      correctionHistory: [
        ...meal.correctionHistory,
        {
          text: correctionText.trim(),
          correctedAt: new Date().toISOString(),
          model: analyzed.model,
        },
      ],
    }));

    if (!updated) {
      await ctx.api
        .editMessageText(
          status.chat.id,
          status.message_id,
          "❌ Could not update that meal entry."
        )
        .catch(async () => {
          await ctx.reply("❌ Could not update that meal entry.");
        });
      return;
    }

    await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    await sendMealSummary(ctx, updated, true);
    await auditLog(access.userId, access.username, "MEAL_CORRECTION", correctionText);
  } catch (error) {
    console.error("Meal correction failed:", error);
    await ctx.api
      .editMessageText(
        status.chat.id,
        status.message_id,
        `❌ ${String(error).slice(0, 200)}`
      )
      .catch(async () => {
        await ctx.reply(`❌ ${String(error).slice(0, 200)}`);
      });
  } finally {
    typing.stop();
  }
}
