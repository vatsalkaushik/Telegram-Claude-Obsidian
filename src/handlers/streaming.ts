/**
 * Shared streaming callback for Obsidian Telegram Assistant handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";
import type { StatusCallback } from "../types";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
} from "../config";

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  lastContent = new Map<number, string>(); // segment_id -> last sent content
  responseMessages = new Map<number, Message[]>(); // segment_id -> visible assistant messages

  getFinalMessages(): Message[] {
    const orderedSegments = [...this.responseMessages.keys()].sort((a, b) => a - b);
    const seen = new Set<number>();
    const messages: Message[] = [];

    for (const segmentId of orderedSegments) {
      const segmentMessages = this.responseMessages.get(segmentId) || [];
      for (const message of segmentMessages) {
        if (!seen.has(message.message_id)) {
          seen.add(message.message_id);
          messages.push(message);
        }
      }
    }

    return messages;
  }
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState
): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "thinking") {
        // Show thinking inline, compact (first 500 chars)
        const preview =
          content.length > 500 ? content.slice(0, 500) + "..." : content;
        const escaped = escapeHtml(preview);
        const thinkingMsg = await ctx.reply(`🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);
      } else if (statusType === "text" && segmentId !== undefined) {
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create message
          const display =
            content.length > TELEGRAM_SAFE_LIMIT
              ? content.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
              : content;
          const formatted = convertMarkdownToHtml(display);
          try {
            const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
            state.responseMessages.set(segmentId, [msg]);
          } catch (htmlError) {
            // HTML parse failed, fall back to plain text
            console.debug("HTML reply failed, using plain text:", htmlError);
            const msg = await ctx.reply(formatted);
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
            state.responseMessages.set(segmentId, [msg]);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          const display =
            content.length > TELEGRAM_SAFE_LIMIT
              ? content.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
              : content;
          const formatted = convertMarkdownToHtml(display);
          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }
          try {
            await ctx.api.editMessageText(
              msg.chat.id,
              msg.message_id,
              formatted,
              {
                parse_mode: "HTML",
              }
            );
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            console.debug("HTML edit failed, trying plain text:", htmlError);
            try {
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                formatted
              );
              state.lastContent.set(segmentId, formatted);
            } catch (editError) {
              console.debug("Edit message failed:", editError);
            }
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (content) {
          const formatted = convertMarkdownToHtml(content);

          if (!state.textMessages.has(segmentId)) {
            if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
              try {
                const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
                state.textMessages.set(segmentId, msg);
                state.lastContent.set(segmentId, formatted);
                state.responseMessages.set(segmentId, [msg]);
              } catch (htmlError) {
                console.debug("HTML final reply failed, using plain text:", htmlError);
                const msg = await ctx.reply(formatted);
                state.textMessages.set(segmentId, msg);
                state.lastContent.set(segmentId, formatted);
                state.responseMessages.set(segmentId, [msg]);
              }
              return;
            }

            const chunkMessages: Message[] = [];
            for (let i = 0; i < formatted.length; i += TELEGRAM_SAFE_LIMIT) {
              const chunk = formatted.slice(i, i + TELEGRAM_SAFE_LIMIT);
              try {
                const msg = await ctx.reply(chunk, { parse_mode: "HTML" });
                chunkMessages.push(msg);
              } catch (htmlError) {
                console.debug(
                  "HTML chunk failed, using plain text:",
                  htmlError
                );
                const msg = await ctx.reply(chunk);
                chunkMessages.push(msg);
              }
            }
            state.responseMessages.set(segmentId, chunkMessages);
            return;
          }

          const msg = state.textMessages.get(segmentId)!;

          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }

          if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
            try {
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                formatted,
                {
                  parse_mode: "HTML",
                }
              );
              state.lastContent.set(segmentId, formatted);
              state.responseMessages.set(segmentId, [msg]);
            } catch (error) {
              console.debug("Failed to edit final message:", error);
            }
          } else {
            // Too long - delete and split
            try {
              await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
            } catch (error) {
              console.debug("Failed to delete message for splitting:", error);
            }

            const chunkMessages: Message[] = [];
            for (let i = 0; i < formatted.length; i += TELEGRAM_SAFE_LIMIT) {
              const chunk = formatted.slice(i, i + TELEGRAM_SAFE_LIMIT);
              try {
                const chunkMsg = await ctx.reply(chunk, { parse_mode: "HTML" });
                chunkMessages.push(chunkMsg);
              } catch (htmlError) {
                console.debug(
                  "HTML chunk failed, using plain text:",
                  htmlError
                );
                const chunkMsg = await ctx.reply(chunk);
                chunkMessages.push(chunkMsg);
              }
            }

            state.responseMessages.set(segmentId, chunkMessages);
          }
        }
      } else if (statusType === "done") {
        // Delete tool messages - text messages stay
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch (error) {
            console.debug("Failed to delete tool message:", error);
          }
        }
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}
