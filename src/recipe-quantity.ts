const GRAMS_PER_MASS_UNIT: Record<string, number> = {
  g: 1, gram: 1, grams: 1,
  kg: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
  lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
};

function gramsPerRecipeUnit(unit: string) {
  const normalized = unit.replace(/\s+/g, " ").trim().toLowerCase();
  const direct = GRAMS_PER_MASS_UNIT[normalized];
  if (direct !== undefined) return direct;
  const exact = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(g|grams?|kg|kilograms?|oz|ounces?|lb|lbs|pounds?)$/);
  if (exact) return Number(exact[1]) * GRAMS_PER_MASS_UNIT[exact[2]];
  const annotated = normalized.match(/[—-]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)\b/i)
    ?? normalized.match(/\(\s*([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)\s*\)/i)
    ?? normalized.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)\b/i);
  return annotated ? Number(annotated[1]) : undefined;
}

export function recipeIngredientAmountMatches(
  actualAmount?: number,
  actualUnit?: string,
  expectedAmount?: number,
  expectedUnit?: string,
  actualWeight?: string,
) {
  if (expectedAmount === undefined) return true;
  if (actualAmount === undefined || !Number.isFinite(actualAmount) || !Number.isFinite(expectedAmount)) return false;
  const expectedNormalizedUnit = expectedUnit?.replace(/\s+/g, " ").trim().toLowerCase();
  const actualNormalizedUnit = actualUnit?.replace(/\s+/g, " ").trim().toLowerCase();
  const expectedGramsPerUnit = gramsPerRecipeUnit(expectedNormalizedUnit ?? "");
  const expectedGrams = expectedGramsPerUnit === undefined ? undefined : expectedAmount * expectedGramsPerUnit;
  if (expectedGrams !== undefined && actualWeight) {
    const weightMatch = actualWeight.replace(/\s+/g, " ").trim().toLowerCase().match(/(-?[0-9]+(?:\.[0-9]+)?)\s*(kg|g|oz|lb)\b/);
    if (weightMatch) {
      const weightInGrams = Number(weightMatch[1]) * GRAMS_PER_MASS_UNIT[weightMatch[2]];
      if (Number.isFinite(weightInGrams)
        && Math.abs(weightInGrams - expectedGrams) <= Math.max(0.0001, Math.abs(expectedGrams) * 0.00001)) return true;
    }
  }
  if (expectedGrams !== undefined && expectedGramsPerUnit !== undefined) {
    const actualGramsPerUnit = gramsPerRecipeUnit(actualNormalizedUnit ?? "");
    if (actualGramsPerUnit === undefined) return false;
    const actualGrams = actualAmount * actualGramsPerUnit;
    // Cronometer stores converted serving counts to four decimal places: for
    // example 56 g becomes 0.8615 x 65 g, or 55.9975 g. Preserve the browser's
    // gram tolerance when comparing those counts and equivalent mass units.
    const tolerance = GRAMS_PER_MASS_UNIT[expectedNormalizedUnit ?? ""] === 1
      ? Math.max(0.01, Math.abs(expectedGrams) * 0.00001)
      : Math.max(0.0001, Math.abs(expectedAmount) * 0.00001) * expectedGramsPerUnit;
    return Number.isFinite(actualGrams) && Math.abs(actualGrams - expectedGrams) <= tolerance;
  }
  if (expectedNormalizedUnit && actualNormalizedUnit !== expectedNormalizedUnit) return false;
  return Math.abs(actualAmount - expectedAmount) <= Math.max(0.0001, Math.abs(expectedAmount) * 0.00001);
}
