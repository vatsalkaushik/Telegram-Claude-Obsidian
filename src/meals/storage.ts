/**
 * Meal persistence and daily note rendering.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { MEAL_DATA_DIR } from "../config";
import { getDailyNotePath, updateDailyNoteFile } from "../vault";
import type { MealDayLog, MealEntry, MealMacros } from "./types";

const MEALS_SECTION_START = "## Meals\n<!-- bot:meals:start -->";
const MEALS_SECTION_END = "<!-- bot:meals:end -->";

function getMealDayPath(dateStamp: string): string {
  return join(MEAL_DATA_DIR, `${dateStamp}.json`);
}

function roundMacro(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeMacros(entry: MealEntry): MealEntry {
  return {
    ...entry,
    analysis: {
      ...entry.analysis,
      calories: Math.round(entry.analysis.calories),
      protein: roundMacro(entry.analysis.protein),
      carbs: roundMacro(entry.analysis.carbs),
      fat: roundMacro(entry.analysis.fat),
      fiber: roundMacro(entry.analysis.fiber),
    },
  };
}

function formatMacro(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function computeTotals(meals: MealEntry[]): MealMacros {
  return meals.reduce<MealMacros>(
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

function renderMealEntry(entry: MealEntry): string {
  const lines = [
    `### ${entry.analysis.mealType} — ${entry.timeStamp}`,
    `- ${entry.analysis.items.join(", ")}`,
    `- Cal: ${Math.round(entry.analysis.calories)} | P: ${formatMacro(
      entry.analysis.protein
    )}g | C: ${formatMacro(entry.analysis.carbs)}g | F: ${formatMacro(
      entry.analysis.fat
    )}g | Fiber: ${formatMacro(entry.analysis.fiber)}g`,
    `- Confidence: ${entry.analysis.confidence}`,
  ];

  if (entry.userNote) {
    lines.push(`- Note: ${JSON.stringify(entry.userNote)}`);
  }

  if (entry.correctionHistory.length > 0) {
    const corrections = entry.correctionHistory.map((item) => item.text).join(" | ");
    lines.push(`- Corrections: ${JSON.stringify(corrections)}`);
  }

  if (entry.imagePaths.length > 0) {
    lines.push(`- Images: ${entry.imagePaths.map((path) => `![[${path}]]`).join(" ")}`);
  }

  return lines.join("\n");
}

function renderMealsSection(dayLog: MealDayLog): string {
  const totals = computeTotals(dayLog.meals);
  const body: string[] = [
    MEALS_SECTION_START,
    `Calories: ${Math.round(totals.calories)} | Protein: ${formatMacro(
      totals.protein
    )}g | Carbs: ${formatMacro(totals.carbs)}g | Fat: ${formatMacro(
      totals.fat
    )}g | Fiber: ${formatMacro(totals.fiber)}g`,
  ];

  for (const meal of dayLog.meals) {
    body.push("", renderMealEntry(meal));
  }

  body.push(MEALS_SECTION_END);
  return body.join("\n");
}

function replaceMealsSection(existing: string, section: string): string {
  const startIndex = existing.indexOf(MEALS_SECTION_START);

  if (startIndex === -1) {
    const trimmed = existing.trimEnd();
    if (!trimmed) {
      return `${section}\n`;
    }
    return `${trimmed}\n\n${section}\n`;
  }

  const endIndex = existing.indexOf(MEALS_SECTION_END, startIndex);
  if (endIndex === -1) {
    const before = existing.slice(0, startIndex).trimEnd();
    return before ? `${before}\n\n${section}\n` : `${section}\n`;
  }

  const afterIndex = endIndex + MEALS_SECTION_END.length;
  const before = existing.slice(0, startIndex).trimEnd();
  const after = existing.slice(afterIndex).trimStart();

  if (before && after) {
    return `${before}\n\n${section}\n\n${after}`.replace(/\n{3,}/g, "\n\n");
  }
  if (before) {
    return `${before}\n\n${section}\n`;
  }
  if (after) {
    return `${section}\n\n${after}`;
  }
  return `${section}\n`;
}

export async function loadMealDay(
  dateStamp: string
): Promise<MealDayLog | null> {
  try {
    const content = await readFile(getMealDayPath(dateStamp), "utf-8");
    return JSON.parse(content) as MealDayLog;
  } catch {
    return null;
  }
}

export async function saveMealDay(dayLog: MealDayLog): Promise<void> {
  const filePath = getMealDayPath(dayLog.dateStamp);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(dayLog, null, 2) + "\n");
}

export async function addMealEntry(entry: MealEntry): Promise<MealDayLog> {
  const normalizedEntry = normalizeMacros(entry);
  const current = await loadMealDay(entry.dateStamp);
  const next: MealDayLog = current || {
    dateStamp: entry.dateStamp,
    weekday: entry.weekday,
    timeZone: entry.timeZone,
    meals: [],
    updatedAt: new Date().toISOString(),
  };

  next.weekday = entry.weekday;
  next.timeZone = entry.timeZone;
  next.meals.push(normalizedEntry);
  next.updatedAt = new Date().toISOString();

  await saveMealDay(next);
  await syncMealsToDailyNote(next);
  return next;
}

export async function getMealEntry(
  dateStamp: string,
  mealId: string
): Promise<MealEntry | null> {
  const day = await loadMealDay(dateStamp);
  if (!day) {
    return null;
  }
  return day.meals.find((meal) => meal.id === mealId) || null;
}

export async function updateMealEntry(
  dateStamp: string,
  mealId: string,
  updater: (meal: MealEntry) => MealEntry
): Promise<MealEntry | null> {
  const day = await loadMealDay(dateStamp);
  if (!day) {
    return null;
  }

  const mealIndex = day.meals.findIndex((meal) => meal.id === mealId);
  if (mealIndex === -1) {
    return null;
  }

  const existing = day.meals[mealIndex];
  if (!existing) {
    return null;
  }

  const updated = normalizeMacros({
    ...updater(existing),
    updatedAt: new Date().toISOString(),
  });

  day.meals[mealIndex] = updated;
  day.updatedAt = new Date().toISOString();

  await saveMealDay(day);
  await syncMealsToDailyNote(day);
  return updated;
}

export async function syncMealsToDailyNote(dayLog: MealDayLog): Promise<string> {
  const filePath = getDailyNotePath(dayLog.dateStamp, dayLog.weekday);
  await updateDailyNoteFile(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });

    let existing = "";
    try {
      existing = await readFile(filePath, "utf-8");
    } catch {
      existing = "";
    }

    const next = replaceMealsSection(existing, renderMealsSection(dayLog));
    await writeFile(filePath, next);
  });
  return filePath;
}
