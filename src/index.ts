/**
 * Obsidian Telegram Assistant
 *
 * Capture daily notes and access Claude via Telegram.
 */

import { Bot, type Context } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import {
  JOURNAL_TELEGRAM_TOKEN,
  MEAL_TELEGRAM_TOKEN,
  WORKING_DIR,
  ALLOWED_USERS,
} from "./config";
import { startMealSummaryScheduler } from "./meal-summary-scheduler";
import {
  handleJournalStart,
  handleMealStart,
  handleMealRedirect,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleClaude,
  handleTimezone,
  handleJournalText,
  handleMealText,
  handlePhoto,
  handleMealPhoto,
  handleDocument,
  handleMealCommand,
} from "./handlers";

function useSequentialization(
  bot: Bot<Context>,
  serializedCommands: string[]
): void {
  const serialized = new Set(serializedCommands);

  bot.use(
    sequentialize((ctx) => {
      // Callback queries (button clicks) are not sequentialized.
      if (ctx.callbackQuery) {
        return undefined;
      }

      if (ctx.message?.text?.startsWith("/")) {
        const command = ctx.message.text.split(/\s+/)[0]?.toLowerCase();
        if (command && serialized.has(command)) {
          return ctx.chat?.id.toString();
        }
        return undefined;
      }

      return ctx.chat?.id.toString();
    })
  );
}

function registerJournalBot(bot: Bot<Context>): void {
  useSequentialization(bot, ["/claude"]);

  bot.command("start", handleJournalStart);
  bot.command("help", handleJournalStart);
  bot.command("meal", handleMealRedirect);
  bot.command("new", handleNew);
  bot.command("stop", handleStop);
  bot.command("status", handleStatus);
  bot.command("resume", handleResume);
  bot.command("claude", handleClaude);
  bot.command("tz", handleTimezone);

  bot.on("message:text", handleJournalText);
  bot.on("message:photo", handlePhoto);
  bot.on("message:document", handleDocument);

  bot.catch((err) => {
    console.error("Journal bot error:", err);
  });
}

function registerMealBot(bot: Bot<Context>): void {
  useSequentialization(bot, ["/meal"]);

  bot.command("start", handleMealStart);
  bot.command("help", handleMealStart);
  bot.command("meal", handleMealCommand);
  bot.command("tz", handleTimezone);

  bot.on("message:text", handleMealText);
  bot.on("message:photo", handleMealPhoto);

  bot.catch((err) => {
    console.error("Meal bot error:", err);
  });
}

const journalBot = new Bot(JOURNAL_TELEGRAM_TOKEN);
registerJournalBot(journalBot);

const mealBot = MEAL_TELEGRAM_TOKEN ? new Bot(MEAL_TELEGRAM_TOKEN) : null;
if (mealBot) {
  registerMealBot(mealBot);
}

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Obsidian Telegram Assistant");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log(`Meal bot: ${mealBot ? "enabled" : "disabled"}`);
console.log("Starting bot...");

// Get bot info first
const journalBotInfo = await journalBot.api.getMe();
console.log(`Journal bot started: @${journalBotInfo.username}`);

if (mealBot) {
  const mealBotInfo = await mealBot.api.getMe();
  console.log(`Meal bot started: @${mealBotInfo.username}`);
} else {
  console.log("MEAL_TELEGRAM_BOT_TOKEN not set; meal bot not started.");
}

// Start with concurrent runner (commands work immediately)
const runners = [run(journalBot)];
if (mealBot) {
  runners.push(run(mealBot));
}

const stopMealSummaryScheduler = startMealSummaryScheduler(mealBot || journalBot);

// Graceful shutdown
const stopRunner = () => {
  stopMealSummaryScheduler();
  for (const runner of runners) {
    if (runner.isRunning()) {
      console.log("Stopping bot...");
      runner.stop();
    }
  }
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
