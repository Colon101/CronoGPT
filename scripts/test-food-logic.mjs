#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chooseFoodLogResult,
  customFoodCreatePreview,
  customFoodNutrientEntries,
  customFoodUpdatePreview,
  customFoodWritePreview,
  foodSearchTabAttempts,
  parseFoodSearchResults,
  parseServingSize,
  rankFoodResults,
  servingSizeRowMatches,
  verifyCustomFoodWrite,
} from "../dist/providers/browser.js";
import { customFoodNutrientLabelForKey } from "../dist/nutrients.js";
import { gtinCheckDigit, validateBarcode } from "../dist/barcode.js";
import {
  FOOD_LOG_MEALS,
  foodLogBatchIdempotencyKey,
  foodLogIdempotencyKey,
  isValidFoodLogDate,
  normalizeFoodLogInput,
  normalizeFoodLogQuery,
  normalizeFoodLogUnit,
  parseFoodLogTimestamp,
  retryGuidanceForFoodLog,
  verifyFoodLogInDiaryEntries,
  verifyFoodLogInDiaryText,
} from "../dist/food-log-transaction.js";

const bananaResults = [
  { name: "Banana cream", source: "Custom Recipe", raw: "Banana cream Custom Recipe" },
  { name: "Banana", source: "NCCDB", raw: "Banana NCCDB" },
  { name: "Banana", source: "CRDB", raw: "Banana CRDB" },
  { name: "Banana, dried", source: "USDA", raw: "Banana, dried USDA" },
];

const emptyCustomSearch = `Add Food to Diary
SEARCH
All
Favorites
Common Foods
Beverages
Supplements
Brands
Restaurants
Custom
All
Foods
Recipes
Meals
Can't find what you're looking for? Check your spelling, try alternatives, or create a Custom Food`;
assert.deepEqual(parseFoodSearchResults(emptyCustomSearch, 10), []);

const orangeSearch = `Add Food to Diary
SEARCH
Description
Source
Orange Juice, Fresh
NCCDB
Fresh Squeezed Orange Juice
FDC UPC
Orange Juice, Fresh Squeezed
CFCD`;
assert.deepEqual(parseFoodSearchResults(orangeSearch, 10), [
  { name: "Orange Juice, Fresh", source: "NCCDB", raw: "Orange Juice, Fresh NCCDB" },
  { name: "Fresh Squeezed Orange Juice", source: "FDC UPC", raw: "Fresh Squeezed Orange Juice FDC UPC" },
  { name: "Orange Juice, Fresh Squeezed", source: "CFCD", raw: "Orange Juice, Fresh Squeezed CFCD" },
]);

assert.deepEqual(parseFoodSearchResults(
  "Add Food to Diary\nDescription Source\nThe Cheesecake Factory, Fresh Orange Juice CRDB\nFoods\nMeals",
  10,
), [
  {
    name: "The Cheesecake Factory, Fresh Orange Juice",
    source: "CRDB",
    raw: "The Cheesecake Factory, Fresh Orange Juice CRDB",
  },
]);

const orangeSelection = chooseFoodLogResult({ query: "fresh orange juice" }, [
  { name: "Albert Heijn, Fresh Orange Juice", source: "CRDB", raw: "Albert Heijn, Fresh Orange Juice CRDB" },
  { name: "Orange Juice, Fresh", source: "NCCDB", raw: "Orange Juice, Fresh NCCDB" },
  { name: "Fresh Squeezed Orange Juice", source: "FDC UPC", raw: "Fresh Squeezed Orange Juice FDC UPC" },
]);
assert.equal(orangeSelection.status, "ok");
assert.equal(orangeSelection.result?.name, "Orange Juice, Fresh");
assert.equal(orangeSelection.result?.source, "NCCDB");
assert.equal(orangeSelection.confidence?.sameWords, true);

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
assert.equal(customFoodNutrientLabelForKey("retinol activity equivalent"), "Vitamin A");
assert.equal(customFoodNutrientLabelForKey("alpha tocopherol"), "Vitamin E");
assert.equal(customFoodNutrientLabelForKey("molybdenum"), "Molybdenum");
assert.equal(customFoodNutrientLabelForKey("imaginary nutrient"), undefined);

assert.equal(validateBarcode("4006 3813-3393 1").normalized, "4006381333931");
assert.equal(validateBarcode("4006 3813-3393 1").valid, true);
assert.equal(validateBarcode("036000291452").valid, true);
// UPC-E encodes the UPC-A payload 042000001007.
assert.equal(validateBarcode("04210007").valid, true);
assert.equal(validateBarcode("96385074").valid, true);
assert.equal(validateBarcode("4006381333932").valid, false);
assert.equal(gtinCheckDigit("400638133393"), 1);

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
  ["caffeine", "Caffeine", 80],
  ["net_carbs", "Total Carbs", 4],
  ["omega-3 dha", "DHA", 0.2],
  ["20:5n3", "EPA", 0.1],
  ["protein_g", "Protein", 7],
  ["vitamin_c", "Vitamin C", 12],
]);

const preview = customFoodWritePreview({
  servingSize: "1 serving",
  nutrients: { calories: 10, "omega-3 dha": 0.2, invalid_number: Number.NaN },
});
assert.equal(preview.servingSize.parsed.unit, "serving");
assert.equal(preview.nutrientCount, 2);
assert.deepEqual(preview.ignoredNutrients, [{
  sourceKey: "invalid_number",
  value: "NaN",
  warning: "Nutrient value must be a finite number.",
}]);

const unknownNutrientPreview = customFoodWritePreview({
  servingSize: "1 serving",
  nutrients: { imaginary_nutrient: 4 },
});
assert.equal(unknownNutrientPreview.valid, false);
assert.match(unknownNutrientPreview.issues.join(" "), /Unknown nutrient key/);

const duplicateNutrientPreview = customFoodWritePreview({
  servingSize: "1 serving",
  nutrients: { total_carbs: 10, net_carbs: 9 },
});
assert.equal(duplicateNutrientPreview.valid, false);
assert.match(duplicateNutrientPreview.issues.join(" "), /supplied more than once/);

const incompleteCreatePreview = customFoodCreatePreview({ name: "Incomplete" });
assert.equal(incompleteCreatePreview.valid, false);
assert.match(incompleteCreatePreview.issues.join(" "), /servingSize is required/);
assert.match(incompleteCreatePreview.issues.join(" "), /At least one package-label nutrient/);

const barcodePreview = customFoodWritePreview({
  name: "Barcode food",
  servingSize: "250 ml",
  barcode: "4006 3813-3393 1",
  nutrients: { calories: 10, vitamin_a: 25, chromium: 3 },
});
assert.equal(barcodePreview.valid, true);
assert.equal(barcodePreview.barcode.normalized, "4006381333931");
assert.deepEqual(barcodePreview.nutrients.map((entry) => entry.label), ["Energy", "Vitamin A", "Chromium"]);

const invalidPreview = customFoodWritePreview({
  name: "Invalid barcode food",
  servingSize: "not a serving",
  barcode: "4006381333932",
  nutrients: { sodium: -1 },
});
assert.equal(invalidPreview.valid, false);
assert.equal(invalidPreview.issues.length, 3);
assert.equal(customFoodWritePreview({ name: "Food", servingSize: "" }).valid, false);

const invalidUpdate = customFoodUpdatePreview({ name: "Barcode food" });
assert.equal(invalidUpdate.valid, false);
assert.match(invalidUpdate.issues.join(" "), /at least one changed field/i);
assert.equal(customFoodUpdatePreview({ name: "Barcode food", barcode: "4006381333931" }).valid, true);
assert.equal(customFoodUpdatePreview({ newName: "Renamed food" }).valid, false);
assert.match(customFoodUpdatePreview({ newName: "Renamed food" }).issues.join(" "), /exact current custom food name/i);

const verifiedCustomFood = verifyCustomFoodWrite({
  name: "Barcode food",
  servingSize: "250 ml",
  barcodes: ["4006381333931"],
  nutrients: {
    Energy: { value: 10, unit: "kcal" },
    "Vitamin A": { value: 25, unit: "µg" },
    Chromium: { value: 3, unit: "µg" },
  },
}, {
  name: "Barcode food",
  servingSize: "250 ml",
  barcode: "4006381333931",
  nutrients: { calories: 10, vitamin_a: 25, chromium: 3 },
});
assert.equal(verifiedCustomFood.verified, true);
assert.equal(verifiedCustomFood.barcodeVerified, true);
assert.equal(verifiedCustomFood.nutrientsVerified, true);

const mismatchedCustomFood = verifyCustomFoodWrite({
  name: "Barcode food",
  servingSize: "250 ml",
  barcodes: [],
  nutrients: { Energy: { value: 9, unit: "kcal" } },
}, {
  name: "Barcode food",
  servingSize: "250 ml",
  barcode: "4006381333931",
  nutrients: { calories: 10 },
});
assert.equal(mismatchedCustomFood.verified, false);
assert.match(mismatchedCustomFood.issues.join(" "), /barcode/i);
assert.match(mismatchedCustomFood.issues.join(" "), /Energy/);

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
assert.equal(bestEffort.status, "needs_manual_step");
assert.match(bestEffort.warning ?? "", /disabled/i);

assert.equal(normalizeFoodLogQuery("1% fat milk"), "milk 1%");
assert.equal(normalizeFoodLogQuery("Add one percent low fat milk"), "milk 1%");
assert.equal(normalizeFoodLogQuery("low fat milk"), "low fat milk");
assert.equal(normalizeFoodLogUnit("grams"), "g");
assert.equal(normalizeFoodLogUnit("micrograms"), "mcg");
assert.equal(normalizeFoodLogUnit("tablespoons"), "tbsp");
assert.equal(normalizeFoodLogUnit("servings"), "serving");
assert.deepEqual(FOOD_LOG_MEALS, ["Breakfast", "Lunch", "Dinner", "Snacks", "Supplements"]);
assert.equal(normalizeFoodLogInput({ query: "Banana" }, "Asia/Jerusalem").validationIssues.some((issue) => issue.includes("Unsupported meal")), true);
assert.equal(isValidFoodLogDate("2026-02-28"), true);
assert.equal(isValidFoodLogDate("2026-02-29"), false);
assert.deepEqual(parseFoodLogTimestamp("13:05"), { normalized: "13:05", hour12: 1, minute: 5, period: "PM" });
assert.deepEqual(parseFoodLogTimestamp("1:05 pm"), { normalized: "1:05 PM", hour12: 1, minute: 5, period: "PM" });
assert.equal(parseFoodLogTimestamp("13 PM"), undefined);
assert.equal(parseFoodLogTimestamp("1"), undefined);

const unsafePolicyLog = normalizeFoodLogInput(
  { query: "Banana", meal: "Lunch", matchPolicy: "best_effort" },
  "Asia/Jerusalem",
  new Date("2026-06-06T08:00:00.000Z"),
);
assert.match(unsafePolicyLog.validationIssues.join(" "), /Unsupported food match policy/);

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
assert.deepEqual(milkLog.validationIssues, []);
assert.deepEqual(milkLog.searchQueries.slice(0, 2), ["Milk, 1% Fat", "Milk, Lowfat, 1%"]);

const sameMilkKey = foodLogIdempotencyKey({
  date: "2026-06-06",
  meal: "dinner",
  query: "MILK 1%",
  amount: 301,
  unit: "G",
});
assert.equal(milkLog.idempotencyKey, sameMilkKey);

const batchKey = foodLogBatchIdempotencyKey([
  milkLog,
  normalizeFoodLogInput(
    { query: "Bananas, Raw", meal: "Dinner", amount: 1, unit: "g", selectedName: "Bananas, Raw" },
    "Asia/Jerusalem",
    new Date("2026-06-06T08:00:00.000Z"),
  ),
]);
const sameBatchKey = foodLogBatchIdempotencyKey([
  milkLog,
  normalizeFoodLogInput(
    { query: "bananas, raw", meal: "dinner", amount: 1, unit: "grams", selectedName: "BANANAS, RAW" },
    "Asia/Jerusalem",
    new Date("2026-06-06T08:00:00.000Z"),
  ),
]);
assert.equal(batchKey, sameBatchKey);

const invalidDestination = normalizeFoodLogInput(
  { query: "Banana", meal: "Brunch", date: "2026-02-29", timestamp: "13 PM" },
  "Asia/Jerusalem",
  new Date("2026-06-06T08:00:00.000Z"),
);
assert.equal(invalidDestination.validationIssues.length, 3);
assert.match(invalidDestination.validationIssues.join(" "), /Unsupported meal/);
assert.match(invalidDestination.validationIssues.join(" "), /Invalid diary date/);
assert.match(invalidDestination.validationIssues.join(" "), /Invalid food time/);

const timedMilk = normalizeFoodLogInput(
  { query: "1% fat milk", meal: "Dinner", amount: 301, unit: "g", timestamp: "13:05" },
  "Asia/Jerusalem",
  new Date("2026-06-06T08:00:00.000Z"),
);
assert.notEqual(timedMilk.idempotencyKey, milkLog.idempotencyKey);

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

const structuredBanana = verifyFoodLogInDiaryEntries([
  { meal: "Breakfast", name: "Bananas, Raw", amount: 1, unit: "g", energyKcal: 0.89 },
  { meal: "Dinner", name: "Other food", amount: 1, unit: "g" },
], bananaGramLog);
assert.equal(structuredBanana.status, "not_verified");
assert.equal(structuredBanana.matchedMeal, true);
assert.equal(structuredBanana.matchedFood, false);
assert.equal(verifyFoodLogInDiaryEntries([
  { meal: "Dinner", name: "Bananas, Raw", amount: 1, unit: "gram" },
], bananaGramLog).status, "verified");
const bananaByHundredGrams = normalizeFoodLogInput(
  { query: "Bananas, Raw", meal: "Dinner", amount: 273, unit: "g", selectedName: "Bananas, Raw" },
  "Asia/Jerusalem",
  new Date("2026-06-09T08:00:00.000Z"),
);
assert.equal(verifyFoodLogInDiaryEntries([
  { meal: "Dinner", name: "Bananas, Raw", amount: 2.73, unit: "× 100 g" },
], bananaByHundredGrams).status, "verified");
assert.equal(verifyFoodLogInDiaryEntries([
  { meal: "Dinner", name: "Bananas, Raw", amount: 1, unit: "bar — 46g" },
], normalizeFoodLogInput(
  { query: "Bananas, Raw", meal: "Dinner", amount: 46, unit: "g", selectedName: "Bananas, Raw" },
  "Asia/Jerusalem",
  new Date("2026-06-09T08:00:00.000Z"),
)).status, "verified");

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
