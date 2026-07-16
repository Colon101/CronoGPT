import type { RecipeIngredientInput, RecipeInput } from "./domain.js";

export type RecipeIngredientsStatus = "parsed" | "empty_confirmed" | "extraction_failed";

export interface ExistingRecipeIngredient {
  name?: unknown;
  source?: unknown;
  database?: unknown;
  amount?: unknown;
  unit?: unknown;
}

export interface ExistingRecipeSummary {
  name?: unknown;
  recipeId?: unknown;
  servings?: unknown;
  servingName?: unknown;
  cookedWeight?: unknown;
  cookedWeightUnit?: unknown;
  ingredients?: unknown;
  ingredientsStatus?: unknown;
}

export interface RecipeSemanticComparison {
  matches: boolean;
  repairable: boolean;
  ingredientsStatus: RecipeIngredientsStatus;
  missingIngredients: RecipeIngredientInput[];
  changedIngredients: Array<{
    requested: RecipeIngredientInput;
    existing: ExistingRecipeIngredient;
    mismatches: string[];
  }>;
  unexpectedIngredients: ExistingRecipeIngredient[];
  fieldMismatches: Record<string, { requested: unknown; existing: unknown }>;
}

export function comparePrivateRecipe(
  requested: RecipeInput,
  existing: ExistingRecipeSummary,
): RecipeSemanticComparison {
  const fieldMismatches: Record<string, { requested: unknown; existing: unknown }> = {};
  compareTextField(fieldMismatches, "name", requested.name, existing.name);
  compareNumberField(fieldMismatches, "servings", requested.servings, existing.servings);
  compareTextField(fieldMismatches, "servingName", requested.servingName, existing.servingName);
  compareNumberField(fieldMismatches, "cookedWeight", requested.cookedWeight, existing.cookedWeight);
  compareUnitField(fieldMismatches, "cookedWeightUnit", requested.cookedWeightUnit, existing.cookedWeightUnit);

  const actualIngredients = Array.isArray(existing.ingredients)
    ? existing.ingredients.filter((item): item is ExistingRecipeIngredient => Boolean(item) && typeof item === "object")
    : [];
  const ingredientsStatus = normalizeIngredientsStatus(existing.ingredientsStatus, actualIngredients);
  const unmatchedActual = new Set(actualIngredients.map((_, index) => index));
  const missingIngredients: RecipeIngredientInput[] = [];
  const changedIngredients: RecipeSemanticComparison["changedIngredients"] = [];

  for (const ingredient of requested.ingredients) {
    const matchIndex = actualIngredients.findIndex((candidate, index) =>
      unmatchedActual.has(index) && ingredientIdentityMatches(ingredient, candidate));
    if (matchIndex < 0) {
      missingIngredients.push(ingredient);
      continue;
    }
    unmatchedActual.delete(matchIndex);
    const actual = actualIngredients[matchIndex];
    const mismatches: string[] = [];
    if (ingredient.amount !== undefined && !numbersEqual(ingredient.amount, actual.amount)) mismatches.push("amount");
    if (ingredient.unit !== undefined && normalizeUnit(ingredient.unit) !== normalizeUnit(actual.unit)) mismatches.push("unit");
    if (ingredient.selectedSource !== undefined && normalizeSource(ingredient.selectedSource) !== normalizeSource(actual.source ?? actual.database)) {
      mismatches.push("source");
    }
    if (mismatches.length > 0) changedIngredients.push({ requested: ingredient, existing: actual, mismatches });
  }

  const unexpectedIngredients = [...unmatchedActual].map((index) => actualIngredients[index]);
  if (ingredientsStatus === "extraction_failed") {
    fieldMismatches.ingredientsStatus = { requested: "parsed", existing: "extraction_failed" };
  } else if (ingredientsStatus === "empty_confirmed" && requested.ingredients.length > 0) {
    fieldMismatches.ingredientsStatus = { requested: "parsed", existing: "empty_confirmed" };
  }

  const ingredientsMatch = ingredientsStatus === "parsed"
    && missingIngredients.length === 0
    && changedIngredients.length === 0
    && unexpectedIngredients.length === 0;
  const fieldsMatch = Object.keys(fieldMismatches).length === 0;
  const repairable = ingredientsStatus !== "extraction_failed"
    && changedIngredients.length === 0
    && unexpectedIngredients.length === 0;

  return {
    matches: fieldsMatch && ingredientsMatch,
    repairable,
    ingredientsStatus,
    missingIngredients,
    changedIngredients,
    unexpectedIngredients,
    fieldMismatches,
  };
}

function ingredientIdentityMatches(requested: RecipeIngredientInput, existing: ExistingRecipeIngredient) {
  const requestedName = normalizeName(requested.selectedName ?? requested.query);
  const existingName = normalizeName(existing.name);
  if (!requestedName || requestedName !== existingName) return false;
  if (requested.selectedSource === undefined) return true;
  return normalizeSource(requested.selectedSource) === normalizeSource(existing.source ?? existing.database);
}

function normalizeIngredientsStatus(value: unknown, ingredients: ExistingRecipeIngredient[]): RecipeIngredientsStatus {
  if (value === "parsed" || value === "empty_confirmed" || value === "extraction_failed") return value;
  return ingredients.length > 0 ? "parsed" : "extraction_failed";
}

function compareTextField(
  mismatches: Record<string, { requested: unknown; existing: unknown }>,
  field: string,
  requested: unknown,
  existing: unknown,
) {
  if (requested === undefined) return;
  if (normalizeName(requested) !== normalizeName(existing)) mismatches[field] = { requested, existing };
}

function compareUnitField(
  mismatches: Record<string, { requested: unknown; existing: unknown }>,
  field: string,
  requested: unknown,
  existing: unknown,
) {
  if (requested === undefined) return;
  if (normalizeUnit(requested) !== normalizeUnit(existing)) mismatches[field] = { requested, existing };
}

function compareNumberField(
  mismatches: Record<string, { requested: unknown; existing: unknown }>,
  field: string,
  requested: unknown,
  existing: unknown,
) {
  if (requested === undefined) return;
  if (!numbersEqual(requested, existing)) mismatches[field] = { requested, existing };
}

function numbersEqual(left: unknown, right: unknown) {
  const a = typeof left === "number" ? left : Number(String(left ?? "").trim());
  const b = typeof right === "number" ? right : Number(String(right ?? "").trim());
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.000001;
}

function normalizeName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeSource(value: unknown) {
  return normalizeName(value).replace(/^custom$/, "custom food");
}

function normalizeUnit(value: unknown) {
  const unit = normalizeName(value);
  if (["g", "gram", "grams"].includes(unit)) return "g";
  if (["kg", "kilogram", "kilograms"].includes(unit)) return "kg";
  if (["oz", "ounce", "ounces"].includes(unit)) return "oz";
  if (["lb", "lbs", "pound", "pounds"].includes(unit)) return "lb";
  if (["serving", "servings"].includes(unit)) return "serving";
  return unit;
}
