/**
 * Text message handler for Obsidian Telegram Assistant.
 */

import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { getReplyRoute } from "../reply-routes";
import { auditLog, auditLogRateLimit } from "../utils";
import { appendDailyEntry } from "../vault";
import { handleAssistantMessage } from "./assistant";
import {
  extractMealCommandText,
  handleMealCommand,
  handleMealCorrection,
  tryMergePendingMealReply,
} from "./meal";

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

  // 2. Reply routing
  const replyToMessageId = ctx.message?.reply_to_message?.message_id;
  if (replyToMessageId) {
    const pendingMealText = extractMealCommandText(message) ?? message;
    if (
      await tryMergePendingMealReply(ctx, replyToMessageId, pendingMealText)
    ) {
      return;
    }

    const route = getReplyRoute(replyToMessageId);
    if (route?.kind === "meal") {
      await handleMealCorrection(ctx, pendingMealText, {
        mealId: route.mealId,
        dateStamp: route.dateStamp,
      });
      return;
    }
    if (route?.kind === "claude") {
      await handleAssistantMessage(ctx, message, {
        resumeSessionId: route.target,
      });
      return;
    }
  }

  // 3. /meal is handled inline so photo captions can own their own flow
  const mealCommandText = extractMealCommandText(message);
  if (mealCommandText !== null) {
    await handleMealCommand(ctx);
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
