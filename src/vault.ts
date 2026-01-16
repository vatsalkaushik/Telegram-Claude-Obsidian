/**
 * Vault helpers for daily notes, links, and settings.
 */

import { mkdir, readFile, writeFile, appendFile } from "fs/promises";
import { dirname, join } from "path";
import {
  BOT_SETTINGS_FILE,
  DAILY_DIR,
  LINKS_FILE,
  VAULT_TIMEZONE,
} from "./config";

export type VaultSettings = {
  timezone?: string;
};

type ZonedParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  weekday: string;
};

export type DateTimeInfo = {
  timeZone: string;
  dateStamp: string;
  timeStamp: string;
  monthStamp: string;
  weekday: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  });

  const parts = formatter.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      lookup[part.type] = part.value;
    }
  }

  return {
    year: lookup.year || "1970",
    month: lookup.month || "01",
    day: lookup.day || "01",
    hour: lookup.hour || "00",
    minute: lookup.minute || "00",
    weekday: lookup.weekday || "Monday",
  };
}

function normalizeLinkTerm(raw: string): string {
  return raw.trim();
}

export function extractWikilinks(text: string): string[] {
  const results: string[] = [];
  const pattern = /\[\[([^\]]+?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const term = normalizeLinkTerm(match[1] || "");
    if (term) {
      results.push(term);
    }
  }
  return results;
}

export async function loadLinkTerms(): Promise<string[]> {
  try {
    const contents = await readFile(LINKS_FILE, "utf-8");
    const terms: string[] = [];
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^\[\[(.+)\]\]$/);
      if (match && match[1]) {
        terms.push(normalizeLinkTerm(match[1]));
      }
    }
    return terms;
  } catch {
    return [];
  }
}

export async function addLinkTerms(newTerms: string[]): Promise<void> {
  if (newTerms.length === 0) return;

  const existing = await loadLinkTerms();
  const existingSet = new Set(existing.map((t) => t.toLowerCase()));
  const additions = newTerms.filter(
    (term) => term && !existingSet.has(term.toLowerCase())
  );

  if (additions.length === 0) return;

  await mkdir(dirname(LINKS_FILE), { recursive: true });
  const lines = additions.map((term) => `[[${term}]]`).join("\n") + "\n";
  await appendFile(LINKS_FILE, lines);
}

function replaceOutsideWikilinks(
  text: string,
  replacer: (segment: string) => string
): string {
  let result = "";
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("[[", cursor);
    if (start === -1) {
      result += replacer(text.slice(cursor));
      break;
    }

    const end = text.indexOf("]]", start + 2);
    if (end === -1) {
      result += replacer(text.slice(cursor));
      break;
    }

    result += replacer(text.slice(cursor, start));
    result += text.slice(start, end + 2);
    cursor = end + 2;
  }

  return result;
}

export function autoLinkText(text: string, linkTerms: string[]): string {
  if (linkTerms.length === 0) return text;

  const sorted = [...linkTerms].sort((a, b) => b.length - a.length);
  let updated = text;

  for (const term of sorted) {
    if (!term) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi");
    updated = replaceOutsideWikilinks(updated, (segment) =>
      segment.replace(pattern, (match) => {
        if (match === term) {
          return `[[${term}]]`;
        }
        return `[[${term}|${match}]]`;
      })
    );
  }

  return updated;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export async function loadSettings(): Promise<VaultSettings> {
  try {
    const contents = await readFile(BOT_SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(contents) as VaultSettings;
    return parsed || {};
  } catch {
    return {};
  }
}

export async function saveSettings(settings: VaultSettings): Promise<void> {
  await mkdir(dirname(BOT_SETTINGS_FILE), { recursive: true });
  await writeFile(BOT_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

export async function getEffectiveTimezone(): Promise<string> {
  const settings = await loadSettings();
  return settings.timezone || VAULT_TIMEZONE;
}

export async function setTimezone(timeZone: string): Promise<void> {
  const settings = await loadSettings();
  settings.timezone = timeZone;
  await saveSettings(settings);
}

export async function getDateTimeInfo(): Promise<DateTimeInfo> {
  const timeZone = await getEffectiveTimezone();
  const parts = getZonedParts(new Date(), timeZone);
  const dateStamp = `${parts.year}-${parts.month}-${parts.day}`;
  const timeStamp = `${parts.hour}:${parts.minute}`;
  const monthStamp = `${parts.year}-${parts.month}`;

  return {
    timeZone,
    dateStamp,
    timeStamp,
    monthStamp,
    weekday: parts.weekday,
  };
}

export async function appendDailyEntry(
  rawText: string
): Promise<{ filePath: string; dateStamp: string; timeStamp: string }> {
  const { dateStamp, timeStamp, weekday } = await getDateTimeInfo();
  const filePath = join(DAILY_DIR, `${dateStamp}.md`);

  await mkdir(dirname(filePath), { recursive: true });

  let prefix = "";
  let needsNewline = false;

  try {
    const existing = await readFile(filePath, "utf-8");
    if (!existing.trim()) {
      prefix = `# ${dateStamp}, ${weekday}\n\n`;
    } else if (!existing.endsWith("\n")) {
      needsNewline = true;
    }
  } catch {
    prefix = `# ${dateStamp}, ${weekday}\n\n`;
  }

  const newLinks = extractWikilinks(rawText);
  await addLinkTerms(newLinks);
  const linkTerms = await loadLinkTerms();
  const linkedText = autoLinkText(rawText, linkTerms);
  const entryLine = `[${timeStamp}] ${linkedText}\n`;

  const payload = `${prefix}${needsNewline ? "\n" : ""}${entryLine}`;
  await appendFile(filePath, payload);

  return { filePath, dateStamp, timeStamp };
}
