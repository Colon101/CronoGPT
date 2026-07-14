import { createHash } from "node:crypto";
import type { FoodLogInput } from "./domain.js";
import { isoDateInTimeZone } from "./determinism.js";

const KNOWN_MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks", "Supplements"] as const;
const DEFAULT_MEAL = "Breakfast";

export interface NormalizedFoodLog {
  original: FoodLogInput;
  query: string;
  searchQueries: string[];
  meal: string;
  date: string;
  amount?: number;
  unit?: string;
  selectedName?: string;
  selectedSource?: string;
  idempotencyKey: string;
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
  const unit = normalizeFoodLogUnit(input.unit);
  const idempotencyKey = input.idempotencyKey?.trim() || foodLogIdempotencyKey({
    date,
    meal,
    query,
    amount: input.amount,
    unit,
    selectedName: input.selectedName,
    selectedSource: input.selectedSource,
  });

  return {
    original: input,
    query,
    searchQueries: foodLogSearchQueries(query, input.query),
    meal,
    date,
    amount: input.amount,
    unit,
    selectedName: input.selectedName?.trim() || undefined,
    selectedSource: input.selectedSource?.trim() || undefined,
    idempotencyKey,
  };
}

export function normalizeFoodLogQuery(query: string) {
  const value = query.replace(/\s+/g, " ").trim();
  const lower = value.toLowerCase();
  const asksForMilk = /\bmilk\b/.test(lower);
  const asksForOnePercent = /(^|\s)(1\s*%|1\s*percent|one\s*percent)(\s|$)/.test(lower);
  const asksForLowfat = /\b(lowfat|low-fat|low fat)\b/.test(lower);
  if (asksForMilk && (asksForOnePercent || asksForLowfat)) return "milk 1%";
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
  if (!value) return DEFAULT_MEAL;
  const lower = value.toLowerCase();
  if (lower === "snack") return "Snacks";
  const match = KNOWN_MEALS.find((candidate) => candidate.toLowerCase() === lower);
  return match ?? value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeFoodLogUnit(unit?: string) {
  const value = unit?.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (/^(g|gram|grams|grammes)$/.test(lower)) return "g";
  if (/^(kg|kilogram|kilograms)$/.test(lower)) return "kg";
  if (/^(ml|milliliter|milliliters|millilitre|millilitres)$/.test(lower)) return "ml";
  if (/^(oz|ounce|ounces)$/.test(lower)) return "oz";
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

export function todayIsoInTimeZone(timeZone: string, now = new Date()) {
  return isoDateInTimeZone(timeZone, now);
}

export function foodLogIdempotencyKey(input: {
  date: string;
  meal: string;
  query: string;
  amount?: number;
  unit?: string;
  selectedName?: string;
  selectedSource?: string;
}) {
  const canonical = JSON.stringify({
    date: input.date,
    meal: normalizeComparable(input.meal),
    query: normalizeComparable(input.query),
    amount: input.amount ?? null,
    unit: normalizeComparable(input.unit ?? ""),
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
      selectedName: normalized.selectedName,
      selectedSource: normalized.selectedSource,
      idempotencyKey: normalized.idempotencyKey,
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
  return [];
}

function diaryMealSectionText(text: string, meal: string) {
  const lines = text.split(/\r?\n/);
  const mealIndex = lines.findIndex((line) => normalizeComparable(line) === normalizeComparable(meal));
  if (mealIndex < 0) return "";
  const knownMealLabels = new Set([...KNOWN_MEALS.map((value) => normalizeComparable(value)), "health"]);
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
