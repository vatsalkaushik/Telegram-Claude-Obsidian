/**
 * Reply routing for bot-authored messages.
 *
 * Maps Telegram bot message IDs to internal targets such as Claude sessions.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { REPLY_ROUTES_FILE } from "./config";

export type ReplyRoute =
  | {
      kind: "claude";
      target: string;
      updatedAt: string;
    };

const MAX_ROUTES = 500;
const replyRoutes = new Map<number, ReplyRoute>();

function pruneRoutes(): void {
  if (replyRoutes.size <= MAX_ROUTES) {
    return;
  }

  const newestFirst = [...replyRoutes.entries()].sort((a, b) =>
    b[1].updatedAt.localeCompare(a[1].updatedAt)
  );

  replyRoutes.clear();
  for (const [messageId, route] of newestFirst.slice(0, MAX_ROUTES)) {
    replyRoutes.set(messageId, route);
  }
}

async function persistRoutes(): Promise<void> {
  await mkdir(dirname(REPLY_ROUTES_FILE), { recursive: true });

  const serialized = Object.fromEntries(
    [...replyRoutes.entries()].map(([messageId, route]) => [
      String(messageId),
      route,
    ])
  );

  await writeFile(REPLY_ROUTES_FILE, JSON.stringify(serialized, null, 2) + "\n");
}

async function loadRoutes(): Promise<void> {
  try {
    const content = await readFile(REPLY_ROUTES_FILE, "utf-8");
    const parsed = JSON.parse(content) as Record<string, ReplyRoute>;

    for (const [messageId, route] of Object.entries(parsed)) {
      const numericId = Number.parseInt(messageId, 10);
      if (!Number.isNaN(numericId) && route?.kind === "claude" && route.target) {
        replyRoutes.set(numericId, route);
      }
    }

    pruneRoutes();
  } catch {
    // No saved routes yet.
  }
}

await loadRoutes();

export function getReplyRoute(messageId: number): ReplyRoute | undefined {
  return replyRoutes.get(messageId);
}

export async function registerClaudeReplyTargets(
  messageIds: number[],
  sessionId: string
): Promise<void> {
  if (!sessionId || messageIds.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  for (const messageId of messageIds) {
    replyRoutes.set(messageId, {
      kind: "claude",
      target: sessionId,
      updatedAt: now,
    });
  }

  pruneRoutes();
  await persistRoutes();
}

export async function clearReplyRoutes(): Promise<void> {
  replyRoutes.clear();
  await persistRoutes();
}
