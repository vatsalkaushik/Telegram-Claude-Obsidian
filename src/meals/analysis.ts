/**
 * Structured meal analysis using OpenAI multimodal models.
 */

import OpenAI from "openai";
import { extname } from "path";
import { readFile } from "fs/promises";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import {
  MEAL_MODEL_FALLBACK,
  MEAL_MODEL_PRIMARY,
  MEAL_REFERENCE_FOODS_FILE,
  OPENAI_API_KEY,
} from "../config";
import type { MealAnalysisResult, MealPhoto } from "./types";

const MealAnalysisSchema = z.object({
  mealType: z.enum(["Breakfast", "Lunch", "Dinner", "Snack"]),
  items: z.array(z.string().min(1)).min(1),
  calories: z.number().min(0),
  protein: z.number().min(0),
  carbs: z.number().min(0),
  fat: z.number().min(0),
  fiber: z.number().min(0),
  confidence: z.enum(["high", "medium", "low"]),
});

type ParsedMealAnalysis = z.infer<typeof MealAnalysisSchema>;

export interface AnalyzeMealInput {
  note: string;
  photos: MealPhoto[];
  capturedAt: string;
  timeZone: string;
  correctionText?: string;
  priorAnalysis?: MealAnalysisResult;
}

export interface AnalyzeMealOutput {
  analysis: MealAnalysisResult;
  model: string;
}

const mealClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function getImageMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

async function imageToDataUrl(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const mimeType = getImageMimeType(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function loadReferenceFoods(): Promise<string> {
  try {
    return await readFile(MEAL_REFERENCE_FOODS_FILE, "utf-8");
  } catch {
    return "";
  }
}

function buildDeveloperPrompt(referenceFoods: string): string {
  const referenceSection = referenceFoods.trim()
    ? `\nReference foods:\n${referenceFoods.trim()}\n`
    : "\nReference foods: none provided.\n";

  return [
    "You analyze personal meal logs and estimate macros.",
    "Return only the structured schema.",
    "Estimate the amount actually consumed, not the amount served.",
    "Use the user note and any correction text to adjust portions or ingredients.",
    "Use reference foods exactly when they clearly match a branded or named staple.",
    "Infer mealType from the meal itself, time, and note.",
    "Confidence rules:",
    "- high: clearly identifiable food and portion, or exact reference-food match",
    "- medium: identifiable food but portions or composition are somewhat ambiguous",
    "- low: dish or portion is too ambiguous for a reliable estimate",
    referenceSection,
  ].join("\n");
}

async function runAnalysis(
  model: string,
  input: AnalyzeMealInput
): Promise<ParsedMealAnalysis> {
  if (!mealClient) {
    throw new Error("Meal analysis is not configured. Set OPENAI_API_KEY in .env");
  }

  const referenceFoods = await loadReferenceFoods();
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text: [
        `Captured at: ${input.capturedAt}`,
        `Time zone: ${input.timeZone}`,
        `User note: ${input.note || "(none)"}`,
        input.priorAnalysis
          ? `Prior analysis: ${JSON.stringify(input.priorAnalysis)}`
          : "",
        input.correctionText
          ? `Correction: ${input.correctionText}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];

  for (const photo of input.photos) {
    content.push({
      type: "image_url",
      image_url: {
        url: await imageToDataUrl(photo.fullPath),
        detail: "high",
      },
    });
  }

  const completion = await mealClient.chat.completions.parse({
    model,
    messages: [
      {
        role: "developer",
        content: buildDeveloperPrompt(referenceFoods),
      },
      {
        role: "user",
        content,
      },
    ],
    response_format: zodResponseFormat(MealAnalysisSchema, "meal_analysis"),
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("Meal analysis returned no structured result");
  }

  return parsed;
}

export async function analyzeMeal(
  input: AnalyzeMealInput
): Promise<AnalyzeMealOutput> {
  const mustUseFallback = !!input.correctionText;
  if (mustUseFallback) {
    return {
      analysis: await runAnalysis(MEAL_MODEL_FALLBACK, input),
      model: MEAL_MODEL_FALLBACK,
    };
  }

  const primary = await runAnalysis(MEAL_MODEL_PRIMARY, input);
  if (primary.confidence === "low") {
    return {
      analysis: await runAnalysis(MEAL_MODEL_FALLBACK, input),
      model: MEAL_MODEL_FALLBACK,
    };
  }

  return {
    analysis: primary,
    model: MEAL_MODEL_PRIMARY,
  };
}
