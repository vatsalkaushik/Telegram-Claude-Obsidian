/**
 * Text message handler for Obsidian Telegram Assistant.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit } from "../utils";
import { appendDailyEntry } from "../vault";

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Commands are handled elsewhere
  if (message.startsWith("/")) {
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 4. Append to daily note
  try {
    const { dateStamp, timeStamp } = await appendDailyEntry(message.trim());
    await auditLog(userId, username, "CAPTURE", message);
    await ctx.reply(`✅ Added to Daily/${dateStamp}.md (${timeStamp})`);
  } catch (error) {
    console.error("Error appending to daily note:", error);
    await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
  }
}
