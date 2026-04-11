/**
 * Meal summary formatting for Telegram digests.
 */

import { loadMealDay } from "./storage";
import type { MealDayLog, MealMacros } from "./types";

type WeeklyDaySummary = {
  dateStamp: string;
  weekdayShort: string;
  totals: MealMacros;
  mealCount: number;
};

function formatMacro(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function computeTotals(dayLog: MealDayLog | null): MealMacros {
  return (dayLog?.meals || []).reduce<MealMacros>(
    (totals, meal) => ({
      calories: totals.calories + meal.analysis.calories,
      protein: totals.protein + meal.analysis.protein,
      carbs: totals.carbs + meal.analysis.carbs,
      fat: totals.fat + meal.analysis.fat,
      fiber: totals.fiber + meal.analysis.fiber,
    }),
    {
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      fiber: 0,
    }
  );
}

function formatDate(dateStamp: string): string {
  const [year, month, day] = dateStamp.split("-").map((part) => parseInt(part, 10));
  const date = new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDateRange(startDateStamp: string, endDateStamp: string): string {
  const [startYear, startMonth, startDay] = startDateStamp
    .split("-")
    .map((part) => parseInt(part, 10));
  const [endYear, endMonth, endDay] = endDateStamp
    .split("-")
    .map((part) => parseInt(part, 10));

  const startDate = new Date(
    Date.UTC(startYear || 1970, (startMonth || 1) - 1, startDay || 1)
  );
  const endDate = new Date(Date.UTC(endYear || 1970, (endMonth || 1) - 1, endDay || 1));

  const startLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(startDate);
  const endLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(endDate);

  return `${startLabel} to ${endLabel}`;
}

function getWeekdayShort(dateStamp: string): string {
  const [year, month, day] = dateStamp.split("-").map((part) => parseInt(part, 10));
  const date = new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "UTC",
  }).format(date);
}

export function shiftDateStamp(dateStamp: string, days: number): string {
  const [year, month, day] = dateStamp.split("-").map((part) => parseInt(part, 10));
  const date = new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));
  date.setUTCDate(date.getUTCDate() + days);

  const nextYear = date.getUTCFullYear();
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(date.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function divideTotals(totals: MealMacros, divisor: number): MealMacros {
  if (divisor <= 0) {
    return {
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      fiber: 0,
    };
  }

  return {
    calories: totals.calories / divisor,
    protein: totals.protein / divisor,
    carbs: totals.carbs / divisor,
    fat: totals.fat / divisor,
    fiber: totals.fiber / divisor,
  };
}

function addTotals(base: MealMacros, next: MealMacros): MealMacros {
  return {
    calories: base.calories + next.calories,
    protein: base.protein + next.protein,
    carbs: base.carbs + next.carbs,
    fat: base.fat + next.fat,
    fiber: base.fiber + next.fiber,
  };
}

async function loadWeeklySummaries(
  endDateStamp: string
): Promise<{
  days: WeeklyDaySummary[];
  totals: MealMacros;
  daysLogged: number;
  mealsLogged: number;
}> {
  const days: WeeklyDaySummary[] = [];
  let totals: MealMacros = {
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    fiber: 0,
  };
  let daysLogged = 0;
  let mealsLogged = 0;

  const startDateStamp = shiftDateStamp(endDateStamp, -6);
  for (let offset = 0; offset < 7; offset += 1) {
    const dateStamp = shiftDateStamp(startDateStamp, offset);
    const dayLog = await loadMealDay(dateStamp);
    const dayTotals = computeTotals(dayLog);
    const mealCount = dayLog?.meals.length || 0;

    if (mealCount > 0) {
      daysLogged += 1;
      mealsLogged += mealCount;
    }

    totals = addTotals(totals, dayTotals);
    days.push({
      dateStamp,
      weekdayShort: getWeekdayShort(dateStamp),
      totals: dayTotals,
      mealCount,
    });
  }

  return {
    days,
    totals,
    daysLogged,
    mealsLogged,
  };
}

export async function buildDailyMealSummary(dateStamp: string): Promise<string> {
  const dayLog = await loadMealDay(dateStamp);
  const totals = computeTotals(dayLog);

  const lines = [`🍽️ <b>Daily Macros Summary</b>`, formatDate(dateStamp), ``];

  if (!dayLog || dayLog.meals.length === 0) {
    lines.push("No meals logged today.");
    return lines.join("\n");
  }

  lines.push(
    `Calories: ${Math.round(totals.calories)}`,
    `Protein: ${formatMacro(totals.protein)}g`,
    `Carbs: ${formatMacro(totals.carbs)}g`,
    `Fat: ${formatMacro(totals.fat)}g`,
    `Fiber: ${formatMacro(totals.fiber)}g`,
    ``,
    `Meals logged: ${dayLog.meals.length}`
  );

  return lines.join("\n");
}

export async function buildWeeklyMealSummary(
  endDateStamp: string
): Promise<string> {
  const startDateStamp = shiftDateStamp(endDateStamp, -6);
  const weekly = await loadWeeklySummaries(endDateStamp);
  const average = divideTotals(weekly.totals, 7);

  const lines = [
    `📊 <b>Weekly Macros Summary</b>`,
    formatDateRange(startDateStamp, endDateStamp),
    ``,
  ];

  if (weekly.mealsLogged === 0) {
    lines.push("No meals logged in the last 7 days.");
    return lines.join("\n");
  }

  lines.push(
    `<b>Totals</b>`,
    `Calories: ${Math.round(weekly.totals.calories)}`,
    `Protein: ${formatMacro(weekly.totals.protein)}g`,
    `Carbs: ${formatMacro(weekly.totals.carbs)}g`,
    `Fat: ${formatMacro(weekly.totals.fat)}g`,
    `Fiber: ${formatMacro(weekly.totals.fiber)}g`,
    ``,
    `<b>Daily average</b>`,
    `Calories: ${Math.round(average.calories)}`,
    `Protein: ${formatMacro(average.protein)}g`,
    `Carbs: ${formatMacro(average.carbs)}g`,
    `Fat: ${formatMacro(average.fat)}g`,
    `Fiber: ${formatMacro(average.fiber)}g`,
    ``,
    `Days logged: ${weekly.daysLogged}/7`,
    `Meals logged: ${weekly.mealsLogged}`,
    ``,
    `<b>By day</b>`
  );

  for (const day of weekly.days) {
    if (day.mealCount === 0) {
      lines.push(`${day.weekdayShort}: no meals logged`);
      continue;
    }

    lines.push(
      `${day.weekdayShort}: ${Math.round(day.totals.calories)} cal | ` +
        `P ${formatMacro(day.totals.protein)}g | ` +
        `C ${formatMacro(day.totals.carbs)}g | ` +
        `F ${formatMacro(day.totals.fat)}g`
    );
  }

  return lines.join("\n");
}
