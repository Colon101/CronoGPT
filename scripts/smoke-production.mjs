#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const defaultOracleDomain = process.env.ORACLE_DOMAIN ?? "cronogpt.129-159-156-186.sslip.io";
const serverUrl = process.env.CRONOGPT_SMOKE_URL ?? `https://${defaultOracleDomain}/mcp`;
const token = process.env.CRONOGPT_API_TOKEN;
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const browserWarmupTimeoutMs = positiveIntegerEnv("CRONOGPT_SMOKE_BROWSER_WARMUP_TIMEOUT_MS", 240000);
const browserProbeTimeoutMs = positiveIntegerEnv("CRONOGPT_SMOKE_BROWSER_TIMEOUT_MS", 180000);
const smokeRecipeName = process.env.CRONOGPT_SMOKE_RECIPE_NAME?.trim();
const smokeRecipeIngredientCount = positiveIntegerEnv("CRONOGPT_SMOKE_RECIPE_INGREDIENT_COUNT", 0);
const expectedDiaryDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

if (!token) {
  throw new Error("Missing CRONOGPT_API_TOKEN.");
}

const checks = [];
const chatGptActionToolNames = [
  "render_cronometer_dashboard",
  "get_daily_summary",
  "list_food_entries",
  "list_biometrics",
  "list_exercises",
  "list_notes",
  "log_food",
  "log_foods",
  "log_food_plan",
  "delete_diary_food_entries",
  "search_foods",
  "custom_food_nutrient_schema",
  "list_custom_foods",
  "create_custom_food",
  "create_and_log_custom_food",
  "delete_custom_food",
  "find_private_recipe",
  "ensure_private_recipe",
  "update_custom_recipe",
  "delete_custom_recipe",
  "get_cronometer_operation",
];

const health = await fetch(serverUrl.replace(/\/mcp\/?$/, "/"));
const healthData = await health.json().catch(() => undefined);
const mockMode = healthData?.mode === "mock";
const healthToolNames = Array.isArray(healthData?.stableModelVisibleTools)
  ? healthData.stableModelVisibleTools
  : [];
const missingHealthTools = chatGptActionToolNames.filter((name) => !healthToolNames.includes(name));
checks.push({
  name: "health",
  ok: health.ok &&
    healthData?.name === "cronogpt" &&
    typeof healthData?.mode === "string" &&
    healthData?.appVersion === packageVersion &&
    healthData?.stableModelVisibleToolCount === chatGptActionToolNames.length &&
    missingHealthTools.length === 0,
  data: {
    ...healthData,
    expectedAppVersion: packageVersion,
    missingHealthTools,
  },
});

await withClient(async (client) => {
  const tools = await client.listTools();
  const dashboardTool = tools.tools.find((tool) => tool.name === "render_cronometer_dashboard");
  const dashboardSecuritySchemes = dashboardTool?._meta?.securitySchemes;
  const capabilitiesTool = tools.tools.find((tool) => tool.name === "cronometer_capabilities");
  const actionTools = chatGptActionToolNames.map((name) => tools.tools.find((tool) => tool.name === name));
  const missingActionTools = chatGptActionToolNames.filter((name, index) => !actionTools[index]);
  const templateBoundActionTools = actionTools
    .filter((tool) => tool && hasOutputTemplate(tool))
    .map((tool) => tool.name);
  const nonModelVisibleActionTools = actionTools
    .filter((tool) => tool && !tool._meta?.ui?.visibility?.includes("model"))
    .map((tool) => tool.name);
  const createCustomFoodTool = tools.tools.find((tool) => tool.name === "create_custom_food");
  const createAndLogCustomFoodTool = tools.tools.find((tool) => tool.name === "create_and_log_custom_food");
  const logFoodTool = tools.tools.find((tool) => tool.name === "log_food");
  const logFoodsTool = tools.tools.find((tool) => tool.name === "log_foods");
  const logFoodPlanTool = tools.tools.find((tool) => tool.name === "log_food_plan");
  const deleteDiaryEntriesTool = tools.tools.find((tool) => tool.name === "delete_diary_food_entries");
  const portionsSchema = createCustomFoodTool?.inputSchema?.properties?.portions;
  const expectedMatchCountSchema = logFoodTool?.inputSchema?.properties?.expectedExistingMatchCount;
  const schemaShapesOk = portionsSchema?.type === "array" &&
    portionsSchema?.items?.properties?.name?.type === "string" &&
    portionsSchema?.items?.properties?.weightGrams?.type === "number" &&
    createAndLogCustomFoodTool?.inputSchema?.properties?.portions?.type === "array" &&
    expectedMatchCountSchema?.type === "integer" &&
    expectedMatchCountSchema?.minimum === 0 &&
    logFoodsTool?.inputSchema?.properties?.items?.items?.properties?.expectedExistingMatchCount?.type === "integer" &&
    logFoodPlanTool?.inputSchema?.properties?.items?.items?.properties?.date?.type === "string" &&
    logFoodPlanTool?.inputSchema?.properties?.items?.items?.properties?.meal?.type === "string" &&
    deleteDiaryEntriesTool?.inputSchema?.properties?.items?.items?.properties?.confirmName?.type === "string";
  checks.push({
    name: "tools",
    ok: tools.tools.length === chatGptActionToolNames.length + 1 &&
      capabilitiesTool?._meta?.ui?.visibility?.includes("app") === true &&
      capabilitiesTool?._meta?.ui?.visibility?.includes("model") !== true &&
      missingActionTools.length === 0 &&
      templateBoundActionTools.length === 1 &&
      templateBoundActionTools[0] === "render_cronometer_dashboard" &&
      nonModelVisibleActionTools.length === 0 &&
      schemaShapesOk &&
      Array.isArray(dashboardSecuritySchemes) &&
      dashboardSecuritySchemes.some((scheme) => scheme?.type === "oauth2"),
    data: {
      count: tools.tools.length,
      hasAppOnlyCapabilities: Boolean(capabilitiesTool),
      missingActionTools,
      templateBoundActionTools,
      nonModelVisibleActionTools,
      schemaShapesOk,
      schemaFragments: {
        portions: portionsSchema,
        createAndLogPortions: createAndLogCustomFoodTool?.inputSchema?.properties?.portions,
        expectedExistingMatchCount: expectedMatchCountSchema,
        batchExpectedExistingMatchCount: logFoodsTool?.inputSchema?.properties?.items?.items?.properties?.expectedExistingMatchCount,
        planDate: logFoodPlanTool?.inputSchema?.properties?.items?.items?.properties?.date,
        planMeal: logFoodPlanTool?.inputSchema?.properties?.items?.items?.properties?.meal,
        deletePlanConfirmName: deleteDiaryEntriesTool?.inputSchema?.properties?.items?.items?.properties?.confirmName,
      },
      dashboardHasOauthMetadata: Array.isArray(dashboardSecuritySchemes) &&
        dashboardSecuritySchemes.some((scheme) => scheme?.type === "oauth2"),
    },
  });

  const dryRun = await client.callTool({
    name: "create_custom_food",
    arguments: {
      name: "cronogpt smoke test dry run",
      portions: [
        { name: "crisp", weightGrams: 8.5 },
        { name: "bag", weightGrams: 85 },
      ],
      barcode: "4006381333931",
      nutrients: { calories: 1, net_carbs: 2, caffeine: 80, "omega-3 dha": 0.2, "20:5n3": 0.1, vitamin_c: 12 },
      dryRun: true,
      confirmed: false,
    },
  });
  const customFoodPreview = dryRun.structuredContent?.data?.preview;
  const customFoodPreviewLabels = customFoodPreview?.nutrients?.map((item) => item?.label) ?? [];
  checks.push({
    name: "custom_food_dry_run",
    ok: dryRun.structuredContent?.status === "dry_run" && (mockMode ||
      customFoodPreview?.servingSize?.parsed?.unit === "g" &&
      customFoodPreview?.servingSize?.parsed?.amount === 1 &&
      customFoodPreview?.portions?.length === 2 &&
      customFoodPreview?.barcode?.normalized === "4006381333931" &&
      customFoodPreviewLabels.includes("Energy") &&
      customFoodPreviewLabels.includes("Total Carbs") &&
      customFoodPreviewLabels.includes("Caffeine") &&
      customFoodPreviewLabels.includes("DHA") &&
      customFoodPreviewLabels.includes("EPA") &&
      customFoodPreviewLabels.includes("Vitamin C")),
    data: {
      status: dryRun.structuredContent?.status,
      feature: dryRun.structuredContent?.feature,
      preview: customFoodPreview,
    },
  });

  const createAndLogDryRun = await client.callTool({
    name: "create_and_log_custom_food",
    arguments: {
      name: "cronogpt smoke test researched snack",
      portions: [
        { name: "crisp", weightGrams: 12 },
        { name: "bag", weightGrams: 120 },
      ],
      barcode: "036000291452",
      nutrients: { calories: 123, protein: 4, net_carbs: 20, total_fat: 3 },
      nutritionSource: "smoke test fixture",
      meal: "Snacks",
      portion: { kind: "whole_package", portion: { name: "bag", weightGrams: 120 } },
      dryRun: true,
      confirmed: false,
    },
  });
  checks.push({
    name: "create_and_log_custom_food_dry_run",
    ok: createAndLogDryRun.structuredContent?.status === "dry_run" && (mockMode ||
      createAndLogDryRun.structuredContent?.data?.createCustomFood?.status === "dry_run" &&
      createAndLogDryRun.structuredContent?.data?.logFood?.status === "dry_run" &&
      createAndLogDryRun.structuredContent?.data?.logFood?.data?.normalized?.meal === "Snacks"),
    data: {
      status: createAndLogDryRun.structuredContent?.status,
      createStatus: createAndLogDryRun.structuredContent?.data?.createCustomFood?.status,
      logStatus: createAndLogDryRun.structuredContent?.data?.logFood?.status,
      logNormalized: createAndLogDryRun.structuredContent?.data?.logFood?.data?.normalized,
    },
  });

  const batchDryRun = await client.callTool({
    name: "log_foods",
    arguments: {
      date: "today",
      meal: "Lunch",
      items: [
        { query: "Banana", amount: 100, unit: "g" },
        { query: "1% fat milk", amount: 62, unit: "grams" },
      ],
      dryRun: true,
      confirmed: false,
    },
  });
  checks.push({
    name: "log_foods_dry_run",
    ok: batchDryRun.structuredContent?.status === "dry_run" && (mockMode ||
      batchDryRun.structuredContent?.data?.browserOpened === false &&
      batchDryRun.structuredContent?.data?.writeAttempted === false &&
      batchDryRun.structuredContent?.data?.count === 2 &&
      batchDryRun.structuredContent?.data?.items?.[0]?.normalized?.meal === "Lunch" &&
      batchDryRun.structuredContent?.data?.items?.[1]?.normalized?.query === "milk 1%"),
    data: {
      status: batchDryRun.structuredContent?.status,
      count: batchDryRun.structuredContent?.data?.count,
      items: batchDryRun.structuredContent?.data?.items,
      browserOpened: batchDryRun.structuredContent?.data?.browserOpened,
      writeAttempted: batchDryRun.structuredContent?.data?.writeAttempted,
    },
  });

  const multiDayPlanDryRun = await client.callTool({
    name: "log_food_plan",
    arguments: {
      items: [
        { date: "yesterday", meal: "Breakfast", query: "Banana", amount: 100, unit: "g" },
        { date: "today", meal: "Lunch", query: "Milk, 1 % Fat, Lowfat", amount: 62, unit: "g" },
      ],
      dryRun: true,
      confirmed: false,
    },
  });
  checks.push({
    name: "log_food_plan_dry_run",
    ok: multiDayPlanDryRun.structuredContent?.status === "dry_run" && (mockMode ||
      multiDayPlanDryRun.structuredContent?.data?.count === 2 &&
      multiDayPlanDryRun.structuredContent?.data?.groupCount === 2 &&
      multiDayPlanDryRun.structuredContent?.data?.groups?.every((group) => group?.data?.browserOpened === false)),
    data: multiDayPlanDryRun.structuredContent,
  });

  const recipeDryRun = await client.callTool({
    name: "ensure_private_recipe",
    arguments: {
      name: "cronogpt smoke test recipe dry run",
      ingredients: [
        {
          query: "Banana",
          selectedName: "Banana",
          selectedSource: "NCCDB",
          amount: 100,
          unit: "g",
        },
      ],
      servings: 1,
      servingName: "serving",
      dryRun: true,
      confirmed: false,
    },
  });
  checks.push({
    name: "recipe_dry_run",
    ok: recipeDryRun.structuredContent?.status === "dry_run" && (mockMode ||
      recipeDryRun.structuredContent?.feature === "ensure_private_recipe" &&
      recipeDryRun.structuredContent?.data?.stage === "preview" &&
      recipeDryRun.structuredContent?.data?.browserOpened === false &&
      recipeDryRun.structuredContent?.data?.writeAttempted === false &&
      recipeDryRun.structuredContent?.data?.preview?.recipeName === "cronogpt smoke test recipe dry run" &&
      Array.isArray(recipeDryRun.structuredContent?.data?.preview?.ingredients)),
    data: {
      status: recipeDryRun.structuredContent?.status,
      feature: recipeDryRun.structuredContent?.feature,
      stage: recipeDryRun.structuredContent?.data?.stage,
      browserOpened: recipeDryRun.structuredContent?.data?.browserOpened,
      writeAttempted: recipeDryRun.structuredContent?.data?.writeAttempted,
      preview: recipeDryRun.structuredContent?.data?.preview,
    },
  });

  const skipBrowserChecks = process.env.CRONOGPT_SMOKE_SKIP_BROWSER === "true";
  if (skipBrowserChecks) {
    const reason = "CRONOGPT_SMOKE_SKIP_BROWSER=true";
    checks.push({
      name: "diary_warmup",
      ok: true,
      skipped: true,
      data: { reason },
    });
    checks.push({
      name: "food_entries_read",
      ok: true,
      skipped: true,
      data: { reason },
    });
    checks.push({
      name: "dated_food_dry_run",
      ok: true,
      skipped: true,
      data: { reason },
    });
    return;
  }

  const diaryWarmup = await callTool(client, "get_daily_summary", {
    date: "today",
  }, { timeout: browserWarmupTimeoutMs });
  checks.push({
    name: "diary_warmup",
    ok: diaryWarmup.structuredContent?.status === "ok" &&
      diaryWarmup.structuredContent?.data?.dateStatus?.selected === true &&
      Boolean(diaryWarmup.structuredContent?.data?.summary),
    data: {
      status: diaryWarmup.structuredContent?.status,
      warning: diaryWarmup.structuredContent?.warning,
      date: diaryWarmup.structuredContent?.data?.date,
      dateStatus: diaryWarmup.structuredContent?.data?.dateStatus,
      summaryPresent: Boolean(diaryWarmup.structuredContent?.data?.summary),
    },
  });

  const foodEntries = await callTool(client, "list_food_entries", {
    date: "today",
  }, { timeout: browserProbeTimeoutMs });
  checks.push({
    name: "food_entries_read",
    ok: foodEntries.structuredContent?.status === "ok" &&
      foodEntries.structuredContent?.data?.dateStatus?.selected === true &&
      foodEntries.structuredContent?.data?.structureVerified === true &&
      Array.isArray(foodEntries.structuredContent?.data?.entries),
    data: {
      status: foodEntries.structuredContent?.status,
      warning: foodEntries.structuredContent?.warning,
      dateStatus: foodEntries.structuredContent?.data?.dateStatus,
      structureVerified: foodEntries.structuredContent?.data?.structureVerified,
      entryCount: foodEntries.structuredContent?.data?.count,
    },
  });

  if (smokeRecipeName) {
    const recipeRead = await callTool(client, "find_private_recipe", {
      name: smokeRecipeName,
    }, { timeout: browserProbeTimeoutMs });
    const recipes = recipeRead.structuredContent?.data?.recipes ?? [];
    const exactRecipe = recipes.find((recipe) => recipe?.name?.toLowerCase() === smokeRecipeName.toLowerCase());
    const ingredients = exactRecipe?.ingredients ?? [];
    checks.push({
      name: "private_recipe_readback",
      ok: recipeRead.structuredContent?.status === "ok" &&
        exactRecipe?.ingredientsStatus === "parsed" &&
        ingredients.length > 0 &&
        (smokeRecipeIngredientCount === 0 || ingredients.length === smokeRecipeIngredientCount),
      data: {
        status: recipeRead.structuredContent?.status,
        warning: recipeRead.structuredContent?.warning,
        recipeName: exactRecipe?.name,
        recipeId: exactRecipe?.recipeId,
        ingredientsStatus: exactRecipe?.ingredientsStatus,
        ingredientCount: ingredients.length,
        expectedIngredientCount: smokeRecipeIngredientCount || undefined,
      },
    });
  }

  const datedFoodDryRun = await client.callTool({
    name: "log_food",
    arguments: {
      date: "today",
      meal: "Breakfast",
      query: "fresh orange juice",
      amount: 272,
      unit: "g",
      dryRun: true,
      confirmed: false,
    },
  });
  checks.push({
    name: "dated_food_dry_run",
    ok: datedFoodDryRun.structuredContent?.status === "dry_run" &&
      datedFoodDryRun.structuredContent?.data?.browserOpened === false &&
      datedFoodDryRun.structuredContent?.data?.writeAttempted === false &&
      datedFoodDryRun.structuredContent?.data?.normalized?.query === "fresh orange juice" &&
      datedFoodDryRun.structuredContent?.data?.normalized?.date === expectedDiaryDate &&
      datedFoodDryRun.structuredContent?.data?.normalized?.meal === "Breakfast" &&
      datedFoodDryRun.structuredContent?.data?.normalized?.amount === 272 &&
      datedFoodDryRun.structuredContent?.data?.normalized?.unit === "g",
    data: {
      status: datedFoodDryRun.structuredContent?.status,
      normalized: datedFoodDryRun.structuredContent?.data?.normalized,
      browserOpened: datedFoodDryRun.structuredContent?.data?.browserOpened,
      writeAttempted: datedFoodDryRun.structuredContent?.data?.writeAttempted,
    },
  });
});

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({ ok, serverUrl, checks }, null, 2));
if (!ok) {
  process.exitCode = 1;
}

async function withClient(fn) {
  const client = new Client({ name: "cronogpt-production-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function callTool(client, name, args, options) {
  return client.callTool({ name, arguments: args }, undefined, options);
}

function hasOutputTemplate(tool) {
  return Boolean(
    tool?._meta?.["openai/outputTemplate"] ||
    tool?._meta?.["ui/resourceUri"] ||
    tool?._meta?.ui?.resourceUri
  );
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer; received ${JSON.stringify(raw)}.`);
  }
  return value;
}
