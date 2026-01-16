/**
 * Assistant handler for Claude Code interactions.
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

export async function handleAssistantMessage(
  ctx: Context,
  message: string
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    await ctx.reply("Please include a message after /claude.");
    return;
  }

  // 3. Store message for retry
  session.lastMessage = trimmed;

  // 4. Mark processing started
  const stopProcessing = session.startProcessing();

  // 5. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 6. Create streaming state and callback
  let state = new StreamingState();
  let statusCallback = createStatusCallback(ctx, state);

  // 7. Send to Claude with retry logic for crashes
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await session.sendMessageStreaming(
        trimmed,
        username,
        userId,
        statusCallback
      );

      await auditLog(userId, username, "CLAUDE", trimmed, response);
      break;
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      for (const toolMsg of state.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {
          // Ignore cleanup errors
        }
      }

      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        console.log(
          `Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await session.kill();
        await ctx.reply(`⚠️ Claude crashed, retrying...`);
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state);
        continue;
      }

      console.error("Error processing message:", error);
      if (errorStr.includes("abort") || errorStr.includes("cancel")) {
        const wasInterrupt = session.consumeInterruptFlag();
        if (!wasInterrupt) {
          await ctx.reply("🛑 Query stopped.");
        }
      } else {
        await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
      }
      break;
    }
  }

  stopProcessing();
  typing.stop();
}
