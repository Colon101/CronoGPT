#!/usr/bin/env node
import "dotenv/config";
import { createProviderFromEnv } from "../dist/providers/index.js";

const confirmValue = "create-and-delete-custom-food";

if (process.env.CRONOGPT_LIVE_WRITE_CONFIRM !== confirmValue) {
  fail(`Set CRONOGPT_LIVE_WRITE_CONFIRM=${confirmValue} to run this live write smoke.`);
}

if (process.env.CRONOMETER_ENABLE_WRITES !== "true") {
  fail("Set CRONOMETER_ENABLE_WRITES=true to run this live write smoke.");
}

const provider = createProviderFromEnv();
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const foodName = `Codex live custom food smoke ${stamp}`;
const nutrients = {
  calories: 12,
  protein_g: 1.2,
  carbs_g: 2.3,
  fat_g: 0.4,
  fiber_g: 0.5,
  "omega-3 dha": 0.01,
  "omega-3 epa": 0.02,
  "omega-3 ala": 0.03,
  vitamin_c: 4,
  selenium: 5,
};

let created = false;

try {
  const createResult = await provider.createCustomFood({
    name: foodName,
    servingSize: "1 serving",
    nutrients,
    duplicatePolicy: "create_new",
    confirmed: true,
    dryRun: false,
    waitForCompletionSeconds: 600,
  });
  emit("create", createResult);
  if (createResult.status !== "ok") fail("create_custom_food did not complete with status ok.");
  created = true;

  const listedAfterCreate = await provider.listCustomFoods({ query: foodName, includeDetails: true, maxDetails: 5 });
  emit("listedAfterCreate", listedAfterCreate);
  const createdTarget = exactCustomFoodTarget(listedAfterCreate, foodName);
  if (!createdTarget) throw new Error("Created custom food was not found in the Custom Foods list.");

  const deleteResult = await provider.deleteCustomFood({
    foodId: createdTarget.foodId,
    name: foodName,
    confirmName: foodName,
    ifUsed: "stop",
    confirmed: true,
    dryRun: false,
    waitForCompletionSeconds: 600,
  });
  emit("delete", deleteResult);
  if (deleteResult.status !== "ok") throw new Error("delete_custom_food did not complete with status ok.");
  created = false;

  const listedAfterDelete = await provider.listCustomFoods({ query: foodName, includeDetails: false, maxDetails: 0 });
  emit("listedAfterDelete", listedAfterDelete);
  const stillListed = exactCustomFoodTarget(listedAfterDelete, foodName);
  if (stillListed) throw new Error("Deleted custom food still appears in the Custom Foods list.");

  console.log(JSON.stringify({
    ok: true,
    foodName,
    created: true,
    deleted: true,
  }, null, 2));
} catch (error) {
  if (created) {
    await cleanupByRetire(foodName);
  }
  throw error;
}

async function cleanupByRetire(name) {
  const retiredName = `${name} retired cleanup`;
  const retired = await provider.retireCustomFood({
    name,
    retiredName,
    confirmed: true,
    dryRun: false,
    waitForCompletionSeconds: 600,
  }).catch((error) => ({
    status: "error",
    warning: error instanceof Error ? error.message : String(error),
  }));
  emit("retireCleanup", retired);
}

function exactCustomFoodTarget(result, name) {
  const data = result.data && typeof result.data === "object" ? result.data : {};
  const foods = Array.isArray(data.foods) ? data.foods : [];
  const fromFoods = foods.find((food) => food && typeof food === "object" && food.name === name);
  if (fromFoods) return fromFoods;
  const names = Array.isArray(data.names) ? data.names : [];
  return names.includes(name) ? { name } : undefined;
}

function emit(step, result) {
  const data = result.data && typeof result.data === "object" ? result.data : {};
  console.log(JSON.stringify({
    step,
    status: result.status,
    warning: result.warning,
    data: summarizeData(data),
  }, null, 2));
}

function summarizeData(data) {
  return {
    action: data.action,
    foodName: data.foodName,
    created: data.created,
    updated: data.updated,
    deleted: data.deleted,
    count: data.count,
    names: Array.isArray(data.names) ? data.names.slice(0, 5) : undefined,
    foods: Array.isArray(data.foods)
      ? data.foods.slice(0, 3).map((food) => ({
          foodId: food.foodId,
          name: food.name,
          servingSize: food.servingSize,
          nutrientCount: Array.isArray(food.nutrients) ? food.nutrients.length : undefined,
        }))
      : undefined,
    nutrients: Array.isArray(data.nutrients)
      ? data.nutrients.map((entry) => ({
          label: entry.label,
          value: entry.value,
          status: entry.status,
          warning: entry.warning,
        }))
      : undefined,
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
