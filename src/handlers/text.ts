/**
 * Text message handler for Obsidian Telegram Assistant.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { getBotRouteScope, getReplyRoute } from "../reply-routes";
import { auditLog, auditLogRateLimit } from "../utils";
import { appendDailyEntry } from "../vault";
import { handleAssistantMessage } from "./assistant";

/**
 * Handle incoming journal bot text messages.
 */
export async function handleJournalText(ctx: Context): Promise<void> {
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

  // 2. Reply routing
  const replyToMessageId = ctx.message?.reply_to_message?.message_id;
  if (replyToMessageId) {
    const route = getReplyRoute(
      getBotRouteScope(ctx.api.token),
      chatId,
      replyToMessageId
    );
    if (route?.kind === "claude") {
      await handleAssistantMessage(ctx, message, {
        resumeSessionId: route.target,
      });
      return;
    }
    if (route?.kind === "meal") {
      await ctx.reply("Meals now go in the meals bot.");
      return;
    }
  }

  // 3. Meals are handled by the dedicated meals bot.
  if (message.trim().match(/^\/meal(?:@\w+)?(?:\s|$)/i)) {
    await ctx.reply("Meals now go in the meals bot. Send the meal text there without /meal.");
    return;
  }

  // 4. Other commands are handled elsewhere
  if (message.startsWith("/")) {
    return;
  }

  // 5. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 6. Append to daily note
  try {
    const { dateStamp, timeStamp } = await appendDailyEntry(message.trim());
    await auditLog(userId, username, "CAPTURE", message);
    await ctx.reply(`✅ Added to Daily/${dateStamp}.md (${timeStamp})`);
  } catch (error) {
    console.error("Error appending to daily note:", error);
    await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
  }
}

export const handleText = handleJournalText;
