/**
 * Types for meal capture, storage, and rendering.
 */

export type MealConfidence = "high" | "medium" | "low";
export type MealType = "Breakfast" | "Lunch" | "Dinner" | "Snack";

export interface MealMacros {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
}

export interface MealAnalysisResult extends MealMacros {
  mealType: MealType;
  items: string[];
  confidence: MealConfidence;
}

export interface MealCorrection {
  text: string;
  correctedAt: string;
  model: string;
}

export interface MealEntry {
  id: string;
  capturedAt: string;
  dateStamp: string;
  timeStamp: string;
  weekday: string;
  timeZone: string;
  userNote: string;
  imagePaths: string[];
  imageFileIds: string[];
  analysis: MealAnalysisResult;
  model: string;
  createdAt: string;
  updatedAt: string;
  correctionHistory: MealCorrection[];
}

export interface MealDayLog {
  dateStamp: string;
  weekday: string;
  timeZone: string;
  meals: MealEntry[];
  updatedAt: string;
}

export interface MealPhoto {
  fullPath: string;
  relativePath: string;
  telegramFileId?: string;
}
