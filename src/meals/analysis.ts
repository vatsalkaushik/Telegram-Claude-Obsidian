/**
 * Structured meal analysis using Anthropic multimodal models.
 */

import Anthropic from "@anthropic-ai/sdk";
import { extname } from "path";
import { readFile } from "fs/promises";
import { z } from "zod";
import {
  ANTHROPIC_API_KEY,
  MEAL_MODEL,
  MEAL_REFERENCE_FOODS_FILE,
} from "../config";
import type { MealAnalysisResult, MealPhoto, MealType } from "./types";

const MealAnalysisSchema = z.object({
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

const mealClient = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

function getImageMediaType(
  filePath: string
): "image/png" | "image/webp" | "image/gif" | "image/jpeg" {
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

async function loadReferenceFoods(): Promise<string> {
  try {
    return await readFile(MEAL_REFERENCE_FOODS_FILE, "utf-8");
  } catch {
    return "";
  }
}

function buildSystemPrompt(referenceFoods: string): string {
  const referenceSection = referenceFoods.trim()
    ? `\nReference foods:\n${referenceFoods.trim()}\n`
    : "\nReference foods: none provided.\n";

  return [
    "You analyze personal meal logs and estimate macros.",
    "Return only valid JSON matching the tool schema.",
    "Estimate the amount actually consumed, not the amount served.",
    "Use the user note and any correction text to adjust portions or ingredients.",
    "Use reference foods exactly when they clearly match a branded or named staple.",
    "Do not classify meal type; that is handled separately.",
    "Confidence rules:",
    "- high: clearly identifiable food and portion, or exact reference-food match",
    "- medium: identifiable food but portions or composition are somewhat ambiguous",
    "- low: dish or portion is too ambiguous for a reliable estimate",
    referenceSection,
  ].join("\n");
}

function getExplicitMealType(text: string | undefined): MealType | null {
  if (!text) {
    return null;
  }

  const normalized = text.trim().toLowerCase();
  const explicitPatterns: Array<{ mealType: MealType; aliases: string[] }> = [
    { mealType: "Snack", aliases: ["snack"] },
    { mealType: "Breakfast", aliases: ["breakfast", "brunch"] },
    { mealType: "Lunch", aliases: ["lunch"] },
    { mealType: "Dinner", aliases: ["dinner", "supper"] },
  ];

  for (const { mealType, aliases } of explicitPatterns) {
    const aliasPattern = `(?:${aliases.join("|")})`;
    const directLabel = new RegExp(
      `^(?:meal\\s*type\\s*[:=-]\\s*)?${aliasPattern}(?:\\s*[:,-]|$)`
    );
    const explicitMention = new RegExp(
      `\\b(?:this|it|meal)\\s+(?:was|is)\\s+(?:an?\\s+)?${aliasPattern}\\b` +
        `|\\b(?:actually|just)\\s+(?:an?\\s+)?${aliasPattern}\\b`
    );

    if (directLabel.test(normalized) || explicitMention.test(normalized)) {
      return mealType;
    }
  }

  return null;
}

function getCapturedHour(capturedAt: string, timeZone: string): number {
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) {
    return new Date().getHours();
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  });

  const hour = formatter.formatToParts(date).find((part) => part.type === "hour")?.value;
  const parsedHour = Number.parseInt(hour || "", 10);
  return Number.isNaN(parsedHour) ? date.getHours() : parsedHour;
}

function deriveMealType(input: AnalyzeMealInput): MealType {
  const explicitType =
    getExplicitMealType(input.correctionText) || getExplicitMealType(input.note);
  if (explicitType) {
    return explicitType;
  }

  const hour = getCapturedHour(input.capturedAt, input.timeZone);

  if (hour < 5) {
    return "Snack";
  }

  if (hour < 11) {
    return "Breakfast";
  }

  if (hour < 17) {
    return "Lunch";
  }

  return "Dinner";
}

function buildAnalysisResult(
  parsed: ParsedMealAnalysis,
  input: AnalyzeMealInput
): MealAnalysisResult {
  return {
    ...parsed,
    mealType: deriveMealType(input),
  };
}

const MEAL_ANALYSIS_TOOL: Anthropic.Messages.Tool = {
  name: "meal_analysis",
  description: "Record the structured macro analysis for a meal.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
      },
      calories: { type: "number", minimum: 0 },
      protein: { type: "number", minimum: 0 },
      carbs: { type: "number", minimum: 0 },
      fat: { type: "number", minimum: 0 },
      fiber: { type: "number", minimum: 0 },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["items", "calories", "protein", "carbs", "fat", "fiber", "confidence"],
  },
};

async function runAnalysis(
  model: string,
  input: AnalyzeMealInput
): Promise<ParsedMealAnalysis> {
  if (!mealClient) {
    throw new Error("Meal analysis is not configured. Set ANTHROPIC_API_KEY in .env");
  }

  const [referenceFoods, ...imageBlocks] = await Promise.all([
    loadReferenceFoods(),
    ...input.photos.map(async (photo) => {
      const buffer = await readFile(photo.fullPath);
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: getImageMediaType(photo.fullPath),
          data: buffer.toString("base64"),
        },
      };
    }),
  ]);

  const content: Anthropic.Messages.ContentBlockParam[] = [...imageBlocks];

  content.push({
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
  });

  const response = await mealClient.messages.create({
    model,
    max_tokens: 1024,
    system: buildSystemPrompt(referenceFoods),
    tools: [MEAL_ANALYSIS_TOOL],
    tool_choice: { type: "tool", name: "meal_analysis" },
    messages: [{ role: "user", content }],
  });

  const toolBlock = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use"
  );

  if (!toolBlock) {
    throw new Error("Meal analysis returned no structured result");
  }

  return MealAnalysisSchema.parse(toolBlock.input);
}

export async function analyzeMeal(
  input: AnalyzeMealInput
): Promise<AnalyzeMealOutput> {
  const parsed = await runAnalysis(MEAL_MODEL, input);
  return {
    analysis: buildAnalysisResult(parsed, input),
    model: MEAL_MODEL,
  };
}
