/**
 * Scheduled Telegram delivery for meal summaries.
 */

import type { Bot } from "grammy";
import {
  getDateTimeInfoForDate,
  getMealSummarySettings,
  rememberMealSummaryTarget,
  updateMealSummarySettings,
} from "./vault";
import { buildDailyMealSummary, buildWeeklyMealSummary, shiftDateStamp } from "./meals/summary";
import { auditLog } from "./utils";

const DAILY_SUMMARY_TIME = "22:00";
const WEEKLY_SUMMARY_TIME = "09:00";
const CHECK_INTERVAL_MS = 60_000;

type SummaryTargetContext = {
  userId: number;
  username?: string;
  chatId: number;
  chatType: string;
};

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

async function sendToAllTargets(
  bot: Bot,
  text: string
): Promise<Array<{ userId: number; username?: string; chatId: number }>> {
  const settings = await getMealSummarySettings();
  const targets = settings.targets || [];
  const delivered: Array<{ userId: number; username?: string; chatId: number }> = [];

  for (const target of targets) {
    try {
      await bot.api.sendMessage(target.chatId, text, {
        parse_mode: "HTML",
      });
      delivered.push({
        userId: target.userId,
        username: target.username,
        chatId: target.chatId,
      });
    } catch (error) {
      console.error("Failed to send meal summary:", error);
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

  const delivered = await sendToAllTargets(bot, await buildDailyMealSummary(now.dateStamp));
  if (delivered.length === 0) {
    return;
  }

  await updateMealSummarySettings({
    dailyLastSentDateStamp: now.dateStamp,
  });

  await Promise.all(
    delivered.map((target) =>
      auditLog(
        target.userId,
        target.username || "unknown",
        "MEAL_SUMMARY_DAILY",
        now.dateStamp
      )
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
  const delivered = await sendToAllTargets(bot, weeklyText);
  if (delivered.length === 0) {
    return;
  }

  await updateMealSummarySettings({
    weeklyLastSentEndDateStamp: latestDueEndDate,
  });

  await Promise.all(
    delivered.map((target) =>
      auditLog(
        target.userId,
        target.username || "unknown",
        "MEAL_SUMMARY_WEEKLY",
        latestDueEndDate
      )
    )
  );
}

export async function rememberSummaryTargetFromContext(
  target: SummaryTargetContext
): Promise<void> {
  if (target.chatType !== "private") {
    return;
  }

  await rememberMealSummaryTarget({
    userId: target.userId,
    username: target.username,
    chatId: target.chatId,
    chatType: target.chatType,
    updatedAt: new Date().toISOString(),
  });
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
