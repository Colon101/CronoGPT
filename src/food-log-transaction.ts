import { createHash } from "node:crypto";
import type { FoodLogInput } from "./domain.js";
import { isoDateInTimeZone } from "./determinism.js";

export const FOOD_LOG_MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks", "Supplements"] as const;
export type FoodLogMeal = typeof FOOD_LOG_MEALS[number];

export interface NormalizedFoodLogTime {
  normalized: string;
  hour12: number;
  minute: number;
  period: "AM" | "PM";
}

export interface DiaryFoodEntry {
  meal: string;
  name: string;
  amount?: number;
  unit?: string;
  energyKcal?: number;
}

export interface NormalizedFoodLog {
  original: FoodLogInput;
  query: string;
  searchQueries: string[];
  meal: string;
  date: string;
  amount?: number;
  unit?: string;
  portion?: {
    kind: "whole_package";
    name: string;
    weightGrams: number;
    count: number;
    resolvedAmount: number;
    resolvedUnit: "g";
  };
  timestamp?: string;
  selectedName?: string;
  selectedSource?: string;
  idempotencyKey: string;
  validationIssues: string[];
}

export interface FoodLogVerification {
  status: "not_attempted" | "verified" | "not_verified";
  matchedFood: boolean;
  matchedAmount: boolean;
  matchedUnit: boolean;
  matchedMeal: boolean;
  textSample?: string;
}

export function normalizeFoodLogInput(input: FoodLogInput, timeZone: string, now = new Date()): NormalizedFoodLog {
  const query = normalizeFoodLogQuery(input.query);
  const meal = normalizeFoodLogMeal(input.meal);
  const date = normalizeFoodLogDate(input.date, timeZone, now);
  const portion = normalizeWholePackagePortion(input.portion);
  const amount = portion?.resolvedAmount ?? input.amount;
  const unit = portion?.resolvedUnit ?? normalizeFoodLogUnit(input.unit);
  const timestamp = parseFoodLogTimestamp(input.timestamp)?.normalized;
  const validationIssues = foodLogValidationIssues(input, { query, meal, date, unit, timestamp, portion });
  const idempotencyKey = input.idempotencyKey?.trim() || foodLogIdempotencyKey({
    date,
    meal,
    query,
    amount,
    unit,
    portion,
    timestamp,
    selectedName: input.selectedName,
    selectedSource: input.selectedSource,
  });

  return {
    original: input,
    query,
    searchQueries: foodLogSearchQueries(query, input.query),
    meal,
    date,
    amount,
    unit,
    portion,
    timestamp,
    selectedName: input.selectedName?.trim() || undefined,
    selectedSource: input.selectedSource?.trim() || undefined,
    idempotencyKey,
    validationIssues,
  };
}

export function normalizeFoodLogQuery(query: string) {
  const value = query.replace(/\s+/g, " ").trim();
  const lower = value.toLowerCase();
  const asksForMilk = /\bmilk\b/.test(lower);
  const asksForOnePercent = /(^|\s)(1\s*%|1\s*percent|one\s*percent)(\s|$)/.test(lower);
  if (asksForMilk && asksForOnePercent) return "milk 1%";
  return value;
}

export function foodLogSearchQueries(normalizedQuery: string, originalQuery?: string) {
  const queries: string[] = [];
  const add = (value?: string) => {
    const trimmed = value?.replace(/\s+/g, " ").trim();
    if (trimmed && !queries.some((candidate) => candidate.toLowerCase() === trimmed.toLowerCase())) {
      queries.push(trimmed);
    }
  };

  if (normalizedQuery.toLowerCase() === "milk 1%") {
    add("Milk, 1% Fat");
    add("Milk, Lowfat, 1%");
  }
  add(normalizedQuery);
  add(originalQuery);
  return queries;
}

export function normalizeFoodLogMeal(meal?: string) {
  const value = meal?.replace(/\s+/g, " ").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (lower === "snack") return "Snacks";
  const match = FOOD_LOG_MEALS.find((candidate) => candidate.toLowerCase() === lower);
  return match ?? value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function isKnownFoodLogMeal(meal: string): meal is FoodLogMeal {
  return FOOD_LOG_MEALS.some((candidate) => candidate === meal);
}

export function normalizeWholePackagePortion(portion?: FoodLogInput["portion"]) {
  if (!portion) return undefined;
  const count = portion.count ?? 1;
  return {
    kind: "whole_package" as const,
    name: portion.portion.name.replace(/\s+/g, " ").trim(),
    weightGrams: portion.portion.weightGrams,
    count,
    resolvedAmount: portion.portion.weightGrams * count,
    resolvedUnit: "g" as const,
  };
}

export function normalizeFoodLogUnit(unit?: string) {
  const value = unit?.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (/^(g|gram|grams|grammes)$/.test(lower)) return "g";
  if (/^(kg|kilogram|kilograms)$/.test(lower)) return "kg";
  if (/^(mg|milligram|milligrams)$/.test(lower)) return "mg";
  if (/^(mcg|ug|µg|μg|microgram|micrograms)$/.test(lower)) return "mcg";
  if (/^(ml|milliliter|milliliters|millilitre|millilitres)$/.test(lower)) return "ml";
  if (/^(l|liter|liters|litre|litres)$/.test(lower)) return "l";
  if (/^(oz|ounce|ounces)$/.test(lower)) return "oz";
  if (/^(lb|lbs|pound|pounds)$/.test(lower)) return "lb";
  if (/^(tsp|teaspoon|teaspoons)$/.test(lower)) return "tsp";
  if (/^(tbsp|tbs|tablespoon|tablespoons)$/.test(lower)) return "tbsp";
  if (/^(cup|cups)$/.test(lower)) return "cup";
  if (/^(serving|servings)$/.test(lower)) return "serving";
  if (/^(piece|pieces)$/.test(lower)) return "piece";
  if (/^(slice|slices)$/.test(lower)) return "slice";
  return value;
}

export function normalizeFoodLogDate(date: string | undefined, timeZone: string, now = new Date()) {
  const today = todayIsoInTimeZone(timeZone, now);
  const value = date?.trim();
  if (!value || value.toLowerCase() === "today") return today;
  if (value.toLowerCase() === "yesterday") return addDaysIso(today, -1);
  if (value.toLowerCase() === "tomorrow") return addDaysIso(today, 1);
  return value;
}

export function isValidFoodLogDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseFoodLogTimestamp(timestamp?: string): NormalizedFoodLogTime | undefined {
  const value = timestamp?.trim();
  if (!value) return undefined;

  const twelveHour = value.match(/^(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*(AM|PM)$/i);
  if (twelveHour) {
    const hour12 = Number(twelveHour[1]);
    const minute = Number(twelveHour[2] ?? "0");
    const period = twelveHour[3].toUpperCase() as "AM" | "PM";
    return {
      normalized: `${hour12}:${String(minute).padStart(2, "0")} ${period}`,
      hour12,
      minute,
      period,
    };
  }

  const twentyFourHour = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!twentyFourHour) return undefined;
  const hour24 = Number(twentyFourHour[1]);
  const minute = Number(twentyFourHour[2]);
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return {
    normalized: `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    hour12,
    minute,
    period,
  };
}

export function foodLogValidationIssues(
  input: FoodLogInput,
  normalized = {
    query: normalizeFoodLogQuery(input.query ?? ""),
    meal: normalizeFoodLogMeal(input.meal),
    date: input.date ?? "",
    unit: normalizeFoodLogUnit(input.unit),
    timestamp: parseFoodLogTimestamp(input.timestamp)?.normalized,
    portion: normalizeWholePackagePortion(input.portion),
  },
) {
  const issues: string[] = [];
  if (!normalized.query) issues.push("Food query must not be blank.");
  if (!isKnownFoodLogMeal(normalized.meal)) {
    issues.push(`Unsupported meal ${JSON.stringify(normalized.meal)}. Use one of: ${FOOD_LOG_MEALS.join(", ")}.`);
  }
  if (!isValidFoodLogDate(normalized.date)) {
    issues.push(`Invalid diary date ${JSON.stringify(normalized.date)}. Use YYYY-MM-DD, today, yesterday, or tomorrow.`);
  }
  if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount <= 0)) {
    issues.push("Food amount must be a finite number greater than zero.");
  }
  if (input.portion && (input.amount !== undefined || input.unit !== undefined)) {
    issues.push("Use either portion or amount/unit, not both.");
  }
  if (input.portion) {
    if (!input.portion.portion.name.trim()) {
      issues.push("Whole-package portion name must not be blank.");
    }
    if (!Number.isFinite(input.portion.portion.weightGrams) || input.portion.portion.weightGrams <= 0) {
      issues.push("Whole-package portion weightGrams must be a finite number greater than zero.");
    }
    if (input.portion.count !== undefined && (!Number.isFinite(input.portion.count) || input.portion.count <= 0)) {
      issues.push("Whole-package portion count must be a finite number greater than zero.");
    }
    if (!Number.isFinite(normalized.portion?.resolvedAmount) || (normalized.portion?.resolvedAmount ?? 0) <= 0) {
      issues.push("Whole-package portion could not be resolved to a positive gram amount.");
    }
  }
  if (input.unit !== undefined && !normalized.unit) issues.push("Food unit must not be blank when provided.");
  if (input.timestamp !== undefined && !normalized.timestamp) {
    issues.push("Invalid food time. Use 24-hour HH:MM (for example 13:05) or 12-hour h:mm AM/PM (for example 1:05 PM).");
  }
  const matchPolicy = (input as { matchPolicy?: string }).matchPolicy;
  if (matchPolicy !== undefined && matchPolicy !== "high_confidence" && matchPolicy !== "selected_only") {
    issues.push(`Unsupported food match policy ${JSON.stringify(matchPolicy)}. Use high_confidence or selected_only.`);
  }
  if (matchPolicy === "selected_only" && !input.selectedName?.trim()) {
    issues.push("selected_only match policy requires selectedName.");
  }
  return issues;
}

export function todayIsoInTimeZone(timeZone: string, now = new Date()) {
  return isoDateInTimeZone(timeZone, now);
}

export function foodLogIdempotencyKey(input: {
  date: string;
  meal: string;
  query: string;
  amount?: number;
  unit?: string;
  portion?: NormalizedFoodLog["portion"];
  timestamp?: string;
  selectedName?: string;
  selectedSource?: string;
}) {
  const canonical = JSON.stringify({
    date: input.date,
    meal: normalizeComparable(input.meal),
    query: normalizeComparable(input.query),
    amount: input.amount ?? null,
    unit: normalizeComparable(input.unit ?? ""),
    portion: input.portion
      ? {
        kind: input.portion.kind,
        name: normalizeComparable(input.portion.name),
        weightGrams: input.portion.weightGrams,
        count: input.portion.count,
        resolvedAmount: input.portion.resolvedAmount,
      }
      : null,
    timestamp: input.timestamp ?? null,
    selectedName: normalizeComparable(input.selectedName ?? ""),
    selectedSource: normalizeComparable(input.selectedSource ?? ""),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function foodLogBatchIdempotencyKey(items: NormalizedFoodLog[]) {
  const canonical = JSON.stringify({
    items: items.map((item) => ({
      idempotencyKey: item.idempotencyKey,
      date: item.date,
      meal: normalizeComparable(item.meal),
      query: normalizeComparable(item.query),
      amount: item.amount ?? null,
      unit: normalizeComparable(item.unit ?? ""),
      portion: item.portion ?? null,
      timestamp: item.timestamp ?? null,
      selectedName: normalizeComparable(item.selectedName ?? ""),
      selectedSource: normalizeComparable(item.selectedSource ?? ""),
    })),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function verifyFoodLogInDiaryText(text: string, normalized: NormalizedFoodLog): FoodLogVerification {
  const comparable = normalizeComparable(text);
  const mealSection = diaryMealSectionText(text, normalized.meal);
  const scopedText = mealSection || text;
  const scopedComparable = normalizeComparable(scopedText);
  const matchedFood = foodTokens(normalized).every((token) => scopedComparable.includes(token));
  const matchedAmount = normalized.amount === undefined || amountPatterns(normalized.amount).some((pattern) => pattern.test(scopedText));
  const matchedUnit = normalized.unit === undefined
    || unitPatterns(normalized.unit, normalized.amount).some((pattern) => pattern.test(scopedText));
  const matchedMeal = Boolean(mealSection) || comparable.includes(normalizeComparable(normalized.meal));
  return {
    status: matchedFood && matchedAmount && matchedUnit && matchedMeal ? "verified" : "not_verified",
    matchedFood,
    matchedAmount,
    matchedUnit,
    matchedMeal,
    textSample: compactText(text, 2500),
  };
}

export interface FoodLogMatchResult {
  count: number;
  matches: DiaryFoodEntry[];
  verification: FoodLogVerification;
}

export function matchFoodLogInDiaryEntries(entries: DiaryFoodEntry[], normalized: NormalizedFoodLog): FoodLogMatchResult {
  const mealEntries = entries.filter((entry) => normalizeComparable(entry.meal) === normalizeComparable(normalized.meal));
  const nameEntries = mealEntries.filter((entry) => foodEntryNameMatches(entry.name, normalized));
  const amountEntries = normalized.amount === undefined
    ? nameEntries
    : nameEntries.filter((entry) => foodEntryAmountMatches(entry, normalized.amount!, normalized.unit));
  const matches = normalized.unit === undefined
    ? amountEntries
    : amountEntries.filter((entry) => foodEntryUnitMatches(entry, normalized.amount, normalized.unit!));
  const matchedMeal = mealEntries.length > 0;
  const matchedFood = nameEntries.length > 0;
  const matchedAmount = normalized.amount === undefined || amountEntries.length > 0;
  const matchedUnit = normalized.unit === undefined || matches.length > 0;
  return {
    count: matches.length,
    matches,
    verification: {
      status: matchedFood && matchedAmount && matchedUnit && matchedMeal ? "verified" : "not_verified",
      matchedFood,
      matchedAmount,
      matchedUnit,
      matchedMeal,
      textSample: compactText(JSON.stringify(mealEntries.slice(0, 30)), 2500),
    },
  };
}

export function foodLogCountDelta(beforeCount: number, afterCount: number, intendedDelta = 1) {
  const actualDelta = afterCount - beforeCount;
  return {
    beforeCount,
    afterCount,
    intendedDelta,
    actualDelta,
    verified: actualDelta === intendedDelta,
    status: actualDelta === intendedDelta ? "verified" as const : "not_verified" as const,
    reason: actualDelta === intendedDelta
      ? undefined
      : actualDelta < intendedDelta
        ? "The diary did not gain the requested number of matching rows."
        : "The diary gained more matching rows than this operation requested.",
  };
}

export function verifyFoodLogInDiaryEntries(entries: DiaryFoodEntry[], normalized: NormalizedFoodLog): FoodLogVerification {
  return matchFoodLogInDiaryEntries(entries, normalized).verification;
}

export function retryGuidanceForFoodLog(status: string) {
  if (status === "busy") return "The browser queue did not free up in time. Check cronometer_runtime_status, then retry once after the active job finishes.";
  if (status === "not_written_login_paused") return "Do not retry until the login cooldown expires or storage state is refreshed.";
  if (status === "not_written_ambiguous") return "Call search_foods and retry with selectedName and selectedSource.";
  if (status === "not_written_not_found") return "Try a more specific food query or create a custom food first.";
  if (status === "possibly_written_verify_failed") return "Run a read-only diary check before any retry to avoid a duplicate.";
  if (status === "already_exists") return "No retry needed; an equivalent diary entry is already present.";
  if (status === "written") return "No retry needed; the write was verified.";
  return "Retry only after checking runtime status.";
}

export function foodLogBrowserPreflightData(normalized: NormalizedFoodLog) {
  return {
    normalized: {
      query: normalized.query,
      searchQueries: normalized.searchQueries,
      meal: normalized.meal,
      date: normalized.date,
      amount: normalized.amount,
      unit: normalized.unit,
      portion: normalized.portion,
      timestamp: normalized.timestamp,
      selectedName: normalized.selectedName,
      selectedSource: normalized.selectedSource,
      idempotencyKey: normalized.idempotencyKey,
      validationIssues: normalized.validationIssues,
    },
  };
}

function foodTokens(normalized: NormalizedFoodLog) {
  if (normalized.query.toLowerCase() === "milk 1%") return ["milk", "1"];
  return normalizeComparable(normalized.selectedName ?? normalized.query)
    .split(" ")
    .filter((token) => token.length >= 2)
    .slice(0, 4);
}

function amountPatterns(amount: number) {
  const escaped = String(amount).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`(^|\\D)${escaped}(\\D|$)`),
    new RegExp(`(^|\\D)${escaped}\\.0+(\\D|$)`),
  ];
}

function unitPatterns(unit: string, amount?: number) {
  const labels = [unit, ...unitAliases(unit)].map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const labelGroup = `(?:${labels.join("|")})`;
  if (amount !== undefined) {
    const amountText = String(amount).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [
      new RegExp(`(^|\\D)${amountText}(?:\\.0+)?\\s*(?:×\\s*)?${labelGroup}(\\W|$)`, "i"),
      new RegExp(`(^|\\D)${amountText}(?:\\.0+)?\\s*\\n\\s*(?:×\\s*)?${labelGroup}(\\W|$)`, "i"),
    ];
  }
  return [new RegExp(`(^|\\W)${labelGroup}(\\W|$)`, "i")];
}

function unitAliases(unit: string) {
  const normalized = unit.trim().toLowerCase();
  if (normalized === "g") return ["gram", "grams"];
  if (normalized === "kg") return ["kilogram", "kilograms"];
  if (normalized === "mg") return ["milligram", "milligrams"];
  if (normalized === "mcg") return ["microgram", "micrograms", "ug", "µg"];
  if (normalized === "ml") return ["milliliter", "milliliters", "millilitre", "millilitres"];
  if (normalized === "oz") return ["ounce", "ounces"];
  if (normalized === "tsp") return ["teaspoon", "teaspoons"];
  if (normalized === "tbsp") return ["tablespoon", "tablespoons", "tbs"];
  if (normalized === "l") return ["liter", "liters", "litre", "litres"];
  if (normalized === "lb") return ["lbs", "pound", "pounds"];
  if (normalized === "cup") return ["cups"];
  if (normalized === "serving") return ["servings"];
  if (normalized === "piece") return ["pieces"];
  if (normalized === "slice") return ["slices"];
  return [];
}

function foodEntryNameMatches(name: string, normalized: NormalizedFoodLog) {
  const actual = normalizeComparable(name);
  const expected = normalizeComparable(normalized.selectedName ?? normalized.query);
  if (actual === expected) return true;
  if (normalized.query.toLowerCase() === "milk 1%") return actual.includes("milk") && /(^|\s)1(\s|$)/.test(actual);
  return false;
}

function foodLogUnitsMatch(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const actualDisplay = normalizeDiaryUnitDisplay(actual);
  const expectedDisplay = normalizeDiaryUnitDisplay(expected);
  const normalizedActual = normalizeFoodLogUnit(actualDisplay)?.toLowerCase();
  const normalizedExpected = normalizeFoodLogUnit(expectedDisplay)?.toLowerCase();
  if (normalizedActual === normalizedExpected) return true;
  const expectedLabels = new Set([normalizedExpected, ...unitAliases(normalizedExpected ?? "")].map((value) => normalizeComparable(value ?? "")));
  return expectedLabels.has(normalizeComparable(actualDisplay));
}

function foodEntryAmountMatches(entry: DiaryFoodEntry, requestedAmount: number, requestedUnit?: string) {
  if (entry.amount === undefined) return false;
  if (numbersMatch(entry.amount, requestedAmount)) return true;
  const multiplier = requestedUnit ? measurePerDiaryUnit(entry.unit, requestedUnit) : undefined;
  return multiplier !== undefined && numbersMatch(entry.amount * multiplier, requestedAmount);
}

function foodEntryUnitMatches(entry: DiaryFoodEntry, requestedAmount: number | undefined, requestedUnit: string) {
  if (foodLogUnitsMatch(entry.unit, requestedUnit)) return true;
  if (requestedAmount === undefined || entry.amount === undefined) return false;
  const multiplier = measurePerDiaryUnit(entry.unit, requestedUnit);
  return multiplier !== undefined && numbersMatch(entry.amount * multiplier, requestedAmount);
}

function measurePerDiaryUnit(actualUnit: string | undefined, requestedUnit: string) {
  if (!actualUnit) return undefined;
  const baseUnit = normalizeFoodLogUnit(requestedUnit)?.toLowerCase();
  if (!baseUnit || !["g", "ml", "mg", "mcg"].includes(baseUnit)) return undefined;
  const escapedUnit = baseUnit === "mcg" ? "(?:mcg|ug|µg|μg)" : baseUnit;
  const display = normalizeDiaryUnitDisplay(actualUnit);
  const patterns = [
    new RegExp(`^(?:×\\s*)?([0-9]+(?:\\.[0-9]+)?)\\s*${escapedUnit}$`, "i"),
    new RegExp(`[—-]\\s*([0-9]+(?:\\.[0-9]+)?)\\s*${escapedUnit}\\b`, "i"),
    new RegExp(`\\(\\s*([0-9]+(?:\\.[0-9]+)?)\\s*${escapedUnit}\\s*\\)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = display.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

function normalizeDiaryUnitDisplay(value: string) {
  return value.replace(/^×\s*/, "").replace(/\s+/g, " ").trim();
}

function numbersMatch(actual: number, expected: number) {
  return Math.abs(actual - expected) <= Math.max(0.000001, Math.abs(expected) * 0.000001);
}

function diaryMealSectionText(text: string, meal: string) {
  const lines = text.split(/\r?\n/);
  const mealIndex = lines.findIndex((line) => normalizeComparable(line) === normalizeComparable(meal));
  if (mealIndex < 0) return "";
  const knownMealLabels = new Set([...FOOD_LOG_MEALS.map((value) => normalizeComparable(value)), "health"]);
  let endIndex = lines.length;
  for (let index = mealIndex + 1; index < lines.length; index += 1) {
    const line = normalizeComparable(lines[index]);
    if (knownMealLabels.has(line)) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(mealIndex, endIndex).join("\n");
}

function normalizeComparable(value: string) {
  return value
    .toLowerCase()
    .replace(/[,()[\]{}%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addDaysIso(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function compactText(text: string, max: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}
