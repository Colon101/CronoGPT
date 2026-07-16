#!/usr/bin/env node
import "dotenv/config";
import { createProviderFromEnv } from "../dist/providers/index.js";
import { gtinCheckDigit } from "../dist/barcode.js";

const confirmValue = "create-log-lunch-and-cleanup-custom-food";

if (process.env.CRONOGPT_LIVE_WRITE_CONFIRM !== confirmValue) {
  fail(`Set CRONOGPT_LIVE_WRITE_CONFIRM=${confirmValue} to run this live write smoke.`);
}
if (process.env.CRONOMETER_ENABLE_WRITES !== "true") {
  fail("Set CRONOMETER_ENABLE_WRITES=true to run this live write smoke.");
}

const provider = createProviderFromEnv();
if (provider.mode !== "browser") fail("The live write smoke requires CRONOMETER_BACKEND=browser.");

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const foodName = `Codex barcode Lunch smoke ${stamp}`;
const barcodeData = `20${stamp.slice(-10)}`;
const barcode = `${barcodeData}${gtinCheckDigit(barcodeData)}`;
const meal = "Lunch";
const date = "today";
const portions = [
  { name: "crisp", weightGrams: 10 },
  { name: "bag", weightGrams: 100 },
];
const nutrients = {
  calories: 12,
  protein_g: 1.2,
  total_carbs: 2.3,
  fat_g: 0.4,
  fiber_g: 0.5,
  dha: 0.01,
  epa: 0.02,
  ala: 0.03,
  vitamin_c: 4,
  selenium: 5,
};

let diaryEntryPresent = false;
let customFoodPresent = false;

try {
  const createAndLog = await provider.createAndLogCustomFood({
    name: foodName,
    servingSize: "1 g",
    portions,
    nutrients,
    barcode,
    duplicatePolicy: "update_existing",
    date,
    meal,
    portion: { kind: "whole_package", portion: portions[1] },
    nutritionSource: "cronogpt deterministic live smoke fixture",
    confirmed: true,
    dryRun: false,
    waitForCompletionSeconds: 600,
  });
  emit("createAndLog", createAndLog);
  customFoodPresent = customFoodMayExist(createAndLog);
  diaryEntryPresent = ["written", "already_exists"].includes(createAndLog.status);
  if (createAndLog.status !== "written") {
    throw new Error(`create_and_log_custom_food returned ${createAndLog.status}; expected a newly verified write.`);
  }

  const diaryAfterLog = await provider.listFoodEntries({ date });
  emit("diaryAfterLog", diaryAfterLog);
  const loggedEntry = exactDiaryEntry(diaryAfterLog, foodName, meal);
  if (!loggedEntry) throw new Error(`The exact ${foodName} row was not found under ${meal}.`);
  diaryEntryPresent = true;

  const listedAfterCreate = await provider.listCustomFoods({ query: foodName, includeDetails: true, maxDetails: 5 });
  emit("listedAfterCreate", listedAfterCreate);
  const createdTarget = exactCustomFoodTarget(listedAfterCreate, foodName);
  if (!createdTarget) throw new Error("The created food was not found in Custom Foods.");
  customFoodPresent = true;
  if (!Array.isArray(createdTarget.barcodes) || !createdTarget.barcodes.includes(barcode)) {
    throw new Error(`The custom food did not read back barcode ${barcode}.`);
  }
  if (!Array.isArray(createdTarget.portions)
    || portions.some((expected) => !createdTarget.portions.some((actual) => actual?.name === expected.name && actual?.weightGrams === expected.weightGrams))) {
    throw new Error(`The custom food did not read back all requested portions: ${JSON.stringify(createdTarget.portions)}.`);
  }
  if (createdTarget.servingSize !== "1 g") {
    throw new Error(`The custom food base serving was ${JSON.stringify(createdTarget.servingSize)}, expected 1 g.`);
  }

  const replay = await provider.createAndLogCustomFood({
    name: foodName,
    servingSize: "1 g",
    portions,
    nutrients,
    barcode,
    duplicatePolicy: "update_existing",
    date,
    meal,
    portion: { kind: "whole_package", portion: portions[1] },
    nutritionSource: "cronogpt deterministic live smoke fixture",
    confirmed: true,
    dryRun: false,
    waitForCompletionSeconds: 600,
  });
  emit("replay", replay);
  if (replay.status !== "written") throw new Error(`Identical replay returned ${replay.status}.`);
  const diaryAfterReplay = await provider.listFoodEntries({ date });
  const matchingAfterReplay = exactDiaryEntries(diaryAfterReplay, foodName, meal);
  if (matchingAfterReplay.length !== 1) throw new Error(`Identical replay changed the exact diary row count to ${matchingAfterReplay.length}.`);

  const deleteDiary = await provider.deleteDiaryFoodEntry({
    date,
    meal,
    name: foodName,
    amount: typeof loggedEntry.amount === "number" ? loggedEntry.amount : undefined,
    unit: typeof loggedEntry.unit === "string" ? loggedEntry.unit : undefined,
    confirmName: foodName,
    confirmed: true,
    dryRun: false,
    waitForCompletionSeconds: 600,
  });
  emit("deleteDiary", deleteDiary);
  if (deleteDiary.status !== "ok") throw new Error(`Diary cleanup returned ${deleteDiary.status}.`);

  const diaryAfterDelete = await provider.listFoodEntries({ date });
  emit("diaryAfterDelete", diaryAfterDelete);
  if (exactDiaryEntry(diaryAfterDelete, foodName, meal)) {
    throw new Error(`The exact ${meal} diary row still exists after cleanup.`);
  }
  diaryEntryPresent = false;

  const deleteFood = await provider.deleteCustomFood({
    foodId: createdTarget.foodId,
    name: foodName,
    confirmName: foodName,
    ifUsed: "force",
    confirmed: true,
    dryRun: false,
    waitForCompletionSeconds: 600,
  });
  emit("deleteFood", deleteFood);
  if (deleteFood.status !== "ok") throw new Error(`Custom-food cleanup returned ${deleteFood.status}.`);

  const listedAfterDelete = await provider.listCustomFoods({ query: foodName, includeDetails: false, maxDetails: 0 });
  emit("listedAfterDelete", listedAfterDelete);
  if (exactCustomFoodTarget(listedAfterDelete, foodName)) {
    throw new Error("The deleted custom food still appears in Custom Foods.");
  }
  customFoodPresent = false;

  console.log(JSON.stringify({
    ok: true,
    foodName,
    barcode,
    meal,
    customFoodCreatedAndVerified: true,
    diaryEntryWrittenAndVerified: true,
    diaryEntryDeletedAndVerified: true,
    customFoodDeletedAndVerified: true,
  }, null, 2));
} catch (error) {
  await bestEffortCleanup();
  throw error;
}

async function bestEffortCleanup() {
  const diary = await provider.listFoodEntries({ date }).catch(() => undefined);
  const diaryEntry = diary && exactDiaryEntry(diary, foodName, meal);
  if (diaryEntry || diaryEntryPresent) {
    const deleted = await provider.deleteDiaryFoodEntry({
      date,
      meal,
      name: foodName,
      amount: typeof diaryEntry?.amount === "number" ? diaryEntry.amount : undefined,
      unit: typeof diaryEntry?.unit === "string" ? diaryEntry.unit : undefined,
      confirmName: foodName,
      confirmed: true,
      dryRun: false,
      waitForCompletionSeconds: 600,
    }).catch((cleanupError) => errorResult(cleanupError));
    emit("deleteDiaryCleanup", deleted);
  }

  const listed = await provider.listCustomFoods({ query: foodName, includeDetails: true, maxDetails: 5 }).catch(() => undefined);
  const target = listed && exactCustomFoodTarget(listed, foodName);
  if (target || customFoodPresent) {
    const deleted = await provider.deleteCustomFood({
      foodId: target?.foodId,
      name: foodName,
      confirmName: foodName,
      ifUsed: "force",
      confirmed: true,
      dryRun: false,
      waitForCompletionSeconds: 600,
    }).catch((cleanupError) => errorResult(cleanupError));
    emit("deleteFoodCleanup", deleted);
    if (deleted.status !== "ok") {
      const retired = await provider.retireCustomFood({
        foodId: target?.foodId,
        name: foodName,
        retiredName: `${foodName} retired cleanup`,
        confirmed: true,
        dryRun: false,
        waitForCompletionSeconds: 600,
      }).catch((cleanupError) => errorResult(cleanupError));
      emit("retireFoodCleanup", retired);
    }
  }
}

function exactDiaryEntry(result, name, requestedMeal) {
  return exactDiaryEntries(result, name, requestedMeal)[0];
}

function exactDiaryEntries(result, name, requestedMeal) {
  const data = dataObject(result);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return entries.filter((entry) => entry && typeof entry === "object" && entry.name === name && entry.meal === requestedMeal);
}

function exactCustomFoodTarget(result, name) {
  const data = dataObject(result);
  const foods = Array.isArray(data.foods) ? data.foods : [];
  const fromFoods = foods.find((food) => food && typeof food === "object" && food.name === name);
  if (fromFoods) return fromFoods;
  const names = Array.isArray(data.names) ? data.names : [];
  return names.includes(name) ? { name } : undefined;
}

function customFoodMayExist(result) {
  const data = dataObject(result);
  const create = data.createCustomFood && typeof data.createCustomFood === "object" ? data.createCustomFood : {};
  return ["ok", "already_exists", "possibly_written_verify_failed"].includes(create.status);
}

function dataObject(result) {
  return result?.data && typeof result.data === "object" ? result.data : {};
}

function emit(step, result) {
  const data = dataObject(result);
  console.log(JSON.stringify({
    step,
    status: result?.status,
    warning: result?.warning,
    data: {
      action: data.action,
      completed: data.completed,
      created: data.created,
      updated: data.updated,
      deleted: data.deleted,
      count: data.count,
      customFoodStatus: data.createCustomFood?.status,
      logFoodStatus: data.logFood?.status,
      names: Array.isArray(data.names) ? data.names.slice(0, 5) : undefined,
      entries: Array.isArray(data.entries)
        ? data.entries.filter((entry) => entry?.name === foodName).slice(0, 5)
        : undefined,
    },
  }, null, 2));
}

function errorResult(error) {
  return { status: "error", warning: error instanceof Error ? error.message : String(error) };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
