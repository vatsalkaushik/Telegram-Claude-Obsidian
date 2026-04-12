/**
 * Scheduled Telegram delivery for meal summaries.
 */

import type { Bot } from "grammy";
import { ALLOWED_USERS } from "./config";
import {
  getDateTimeInfoForDate,
  getMealSummarySettings,
  updateMealSummarySettings,
} from "./vault";
import { buildDailyMealSummary, buildWeeklyMealSummary, shiftDateStamp } from "./meals/summary";
import { auditLog } from "./utils";

const DAILY_SUMMARY_TIME = "22:00";
const WEEKLY_SUMMARY_TIME = "09:00";
const CHECK_INTERVAL_MS = 60_000;

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

function parseTimeStamp(timeStamp: string): number {
  const [hour, minute] = timeStamp.split(":").map((part) => parseInt(part, 10));
  return (hour || 0) * 60 + (minute || 0);
}

function getLatestDueWeeklyEndDate(
  dateStamp: string,
  weekday: string,
  timeStamp: string
): string | null {
  if (weekday === "Sunday") {
    if (parseTimeStamp(timeStamp) < parseTimeStamp(WEEKLY_SUMMARY_TIME)) {
      return shiftDateStamp(dateStamp, -8);
    }
    return shiftDateStamp(dateStamp, -1);
  }

  const weekdayIndex = WEEKDAY_INDEX[weekday];
  if (typeof weekdayIndex !== "number") {
    return null;
  }

  return shiftDateStamp(dateStamp, -(weekdayIndex + 1));
}

async function sendToAllUsers(
  bot: Bot,
  text: string
): Promise<number[]> {
  const delivered: number[] = [];

  for (const userId of ALLOWED_USERS) {
    try {
      await bot.api.sendMessage(userId, text, { parse_mode: "HTML" });
      delivered.push(userId);
    } catch (error) {
      console.error(`Failed to send meal summary to ${userId}:`, error);
    }
  }

  return delivered;
}

async function maybeSendDailySummary(bot: Bot): Promise<void> {
  const now = await getDateTimeInfoForDate(new Date());
  if (parseTimeStamp(now.timeStamp) < parseTimeStamp(DAILY_SUMMARY_TIME)) {
    return;
  }

  const settings = await getMealSummarySettings();
  if (settings.dailyLastSentDateStamp === now.dateStamp) {
    return;
  }

  const delivered = await sendToAllUsers(bot, await buildDailyMealSummary(now.dateStamp));
  if (delivered.length === 0) {
    return;
  }

  await updateMealSummarySettings({
    dailyLastSentDateStamp: now.dateStamp,
  });

  await Promise.all(
    delivered.map((userId) =>
      auditLog(userId, "unknown", "MEAL_SUMMARY_DAILY", now.dateStamp)
    )
  );
}

async function maybeSendWeeklySummary(bot: Bot): Promise<void> {
  const now = await getDateTimeInfoForDate(new Date());
  const latestDueEndDate = getLatestDueWeeklyEndDate(
    now.dateStamp,
    now.weekday,
    now.timeStamp
  );

  if (!latestDueEndDate) {
    return;
  }

  const settings = await getMealSummarySettings();
  if (settings.weeklyLastSentEndDateStamp === latestDueEndDate) {
    return;
  }

  const weeklyText = await buildWeeklyMealSummary(latestDueEndDate);
  const delivered = await sendToAllUsers(bot, weeklyText);
  if (delivered.length === 0) {
    return;
  }

  await updateMealSummarySettings({
    weeklyLastSentEndDateStamp: latestDueEndDate,
  });

  await Promise.all(
    delivered.map((userId) =>
      auditLog(userId, "unknown", "MEAL_SUMMARY_WEEKLY", latestDueEndDate)
    )
  );
}

export function startMealSummaryScheduler(bot: Bot): () => void {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      await maybeSendDailySummary(bot);
      await maybeSendWeeklySummary(bot);
    } catch (error) {
      console.error("Meal summary scheduler failed:", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const interval = setInterval(() => {
    void tick();
  }, CHECK_INTERVAL_MS);

  return () => {
    clearInterval(interval);
  };
}
