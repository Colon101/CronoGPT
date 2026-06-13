#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chooseFoodLogResult,
  customFoodNutrientEntries,
  customFoodWritePreview,
  foodSearchTabAttempts,
  parseServingSize,
  rankFoodResults,
  servingSizeRowMatches,
} from "../dist/providers/browser.js";
import { customFoodNutrientLabelForKey } from "../dist/nutrients.js";
import {
  foodLogIdempotencyKey,
  normalizeFoodLogInput,
  normalizeFoodLogQuery,
  normalizeFoodLogUnit,
  retryGuidanceForFoodLog,
  verifyFoodLogInDiaryText,
} from "../dist/food-log-transaction.js";

const bananaResults = [
  { name: "Banana cream", source: "Custom Recipe", raw: "Banana cream Custom Recipe" },
  { name: "Banana", source: "NCCDB", raw: "Banana NCCDB" },
  { name: "Banana", source: "CRDB", raw: "Banana CRDB" },
  { name: "Banana, dried", source: "USDA", raw: "Banana, dried USDA" },
];

assert.equal(customFoodNutrientLabelForKey("omega-3 dha"), "DHA");
assert.equal(customFoodNutrientLabelForKey("20:5n3"), "EPA");
assert.equal(customFoodNutrientLabelForKey("omega 3 ala"), "ALA");
assert.equal(customFoodNutrientLabelForKey("omega-6 aa"), "AA");
assert.equal(customFoodNutrientLabelForKey("protein_g"), "Protein");
assert.equal(customFoodNutrientLabelForKey("carbs_g"), "Total Carbs");
assert.equal(customFoodNutrientLabelForKey("net_carbs"), "Total Carbs");
assert.equal(customFoodNutrientLabelForKey("available carbohydrates"), "Total Carbs");
assert.equal(customFoodNutrientLabelForKey("fat_g"), "Fat");
assert.equal(customFoodNutrientLabelForKey("fiber_g"), "Fiber");
assert.equal(customFoodNutrientLabelForKey("caffeine"), "Caffeine");

assert.deepEqual(parseServingSize("1 serving"), { amount: 1, amountText: "1", unit: "serving" });
assert.deepEqual(parseServingSize("250 ml"), { amount: 250, amountText: "250", unit: "ml" });
assert.deepEqual(parseServingSize("12 micrograms"), { amount: 12, amountText: "12", unit: "mcg" });
assert.equal(parseServingSize("serving"), undefined);
assert.equal(servingSizeRowMatches("1 serving", "1", "serving"), true);
assert.equal(servingSizeRowMatches("250 milliliters", "250", "ml"), true);

const nutrientEntries = customFoodNutrientEntries({
  calories: 10,
  net_carbs: 4,
  protein_g: 7,
  caffeine: 80,
  "omega-3 dha": 0.2,
  "20:5n3": 0.1,
  vitamin_c: 12,
  invalid_number: Number.NaN,
});
assert.deepEqual(nutrientEntries.map((entry) => [entry.sourceKey, entry.label, entry.value]), [
  ["calories", "Energy", 10],
  ["net_carbs", "Total Carbs", 4],
  ["protein_g", "Protein", 7],
  ["caffeine", "Caffeine", 80],
  ["omega-3 dha", "DHA", 0.2],
  ["20:5n3", "EPA", 0.1],
  ["vitamin_c", "Vitamin C", 12],
]);

const preview = customFoodWritePreview({
  servingSize: "1 serving",
  nutrients: { calories: 10, "omega-3 dha": 0.2, invalid_number: Number.NaN },
});
assert.equal(preview.servingSize.parsed.unit, "serving");
assert.equal(preview.nutrientCount, 2);
assert.deepEqual(preview.ignoredNutrients, [{ sourceKey: "invalid_number", value: "NaN" }]);

assert.deepEqual(foodSearchTabAttempts(undefined, undefined).slice(0, 3), ["All", "Custom", "Favorites"]);
assert.deepEqual(foodSearchTabAttempts("custom", undefined), ["Custom"]);
assert.deepEqual(foodSearchTabAttempts(undefined, "Custom Food").slice(0, 2), ["Custom", "All"]);

const ranked = rankFoodResults("Banana", bananaResults);
assert.equal(ranked[0].name, "Banana");
assert.equal(ranked[0].source, "CRDB");

const exactSelection = chooseFoodLogResult({ query: "Banana" }, bananaResults);
assert.equal(exactSelection.status, "ok");
assert.equal(exactSelection.result?.name, "Banana");
assert.equal(exactSelection.result?.source, "CRDB");

const selectedSource = chooseFoodLogResult({
  query: "Banana",
  selectedName: "Banana",
  selectedSource: "NCCDB",
}, bananaResults);
assert.equal(selectedSource.status, "ok");
assert.equal(selectedSource.result?.source, "NCCDB");

const ambiguousSelected = chooseFoodLogResult({
  query: "Banana",
  selectedName: "Banana",
}, bananaResults);
assert.equal(ambiguousSelected.status, "needs_manual_step");
assert.match(ambiguousSelected.warning ?? "", /selectedSource/);

const staleLookingOnly = chooseFoodLogResult({ query: "Banana" }, [
  { name: "Banana cream", source: "Custom Recipe", raw: "Banana cream Custom Recipe" },
  { name: "Today protein, crispy banana chocolate chips", source: "Custom Food", raw: "Today protein, crispy banana chocolate chips Custom Food" },
]);
assert.equal(staleLookingOnly.status, "needs_manual_step");

const bestEffort = chooseFoodLogResult({ query: "Banana", matchPolicy: "best_effort" }, [
  { name: "Banana cream", source: "Custom Recipe", raw: "Banana cream Custom Recipe" },
]);
assert.equal(bestEffort.status, "ok");

assert.equal(normalizeFoodLogQuery("1% fat milk"), "milk 1%");
assert.equal(normalizeFoodLogQuery("Add one percent low fat milk"), "milk 1%");
assert.equal(normalizeFoodLogUnit("grams"), "g");

const milkLog = normalizeFoodLogInput(
  { query: "1% fat milk", meal: "dinner", amount: 301, unit: "grams" },
  "Asia/Jerusalem",
  new Date("2026-06-06T08:00:00.000Z"),
);
assert.equal(milkLog.query, "milk 1%");
assert.equal(milkLog.meal, "Dinner");
assert.equal(milkLog.date, "2026-06-06");
assert.equal(milkLog.amount, 301);
assert.equal(milkLog.unit, "g");
assert.deepEqual(milkLog.searchQueries.slice(0, 2), ["Milk, 1% Fat", "Milk, Lowfat, 1%"]);

const sameMilkKey = foodLogIdempotencyKey({
  date: "2026-06-06",
  meal: "dinner",
  query: "MILK 1%",
  amount: 301,
  unit: "G",
});
assert.equal(milkLog.idempotencyKey, sameMilkKey);

const verifiedMilk = verifyFoodLogInDiaryText("Dinner\nMilk, 1% Fat\n301 g", milkLog);
assert.equal(verifiedMilk.status, "verified");
assert.equal(verifyFoodLogInDiaryText("Dinner\nMilk, 1% Fat\n250 g", milkLog).status, "not_verified");

const bananaGramLog = normalizeFoodLogInput(
  { query: "Bananas, Raw", meal: "Dinner", amount: 1, unit: "g", selectedName: "Bananas, Raw" },
  "Asia/Jerusalem",
  new Date("2026-06-09T08:00:00.000Z"),
);
const wrongBananaUnit = verifyFoodLogInDiaryText("Dinner\nBananas, Raw\n1\ncup, mashed\n197.99\nkcal", bananaGramLog);
assert.equal(wrongBananaUnit.status, "not_verified");
assert.equal(wrongBananaUnit.matchedAmount, true);
assert.equal(wrongBananaUnit.matchedUnit, false);
const rightBananaUnit = verifyFoodLogInDiaryText("Dinner\nBananas, Raw\n1\ng\n0.89\nkcal", bananaGramLog);
assert.equal(rightBananaUnit.status, "verified");
assert.equal(rightBananaUnit.matchedUnit, true);

const breakfastOnlyMilk = verifyFoodLogInDiaryText(
  "Breakfast\nMilk, 1% Fat\n301\ng\n107.5\nkcal\nLunch\nDinner\nSnacks",
  milkLog,
);
assert.equal(breakfastOnlyMilk.status, "not_verified");
assert.equal(breakfastOnlyMilk.matchedFood, false);

const rankedMilk = rankFoodResults("Milk, 1% Fat", [
  { name: "Milk, 1% Fat", source: "CRDB", raw: "Milk, 1% Fat CRDB" },
  { name: "Milk, Chocolate, 1%", source: "Brand", raw: "Milk, Chocolate, 1% Brand" },
  { name: "Milk, Lowfat, 1%", source: "NCCDB", raw: "Milk, Lowfat, 1% NCCDB" },
]);
assert.equal(rankedMilk[0].name, "Milk, 1% Fat");
assert.equal(rankedMilk[0].source, "CRDB");

assert.match(retryGuidanceForFoodLog("possibly_written_verify_failed"), /read-only diary check/i);

console.log("food logic checks passed");
