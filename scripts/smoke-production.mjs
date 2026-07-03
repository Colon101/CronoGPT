#!/usr/bin/env node
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const defaultOracleDomain = process.env.ORACLE_DOMAIN ?? "cronogpt.129-159-156-186.sslip.io";
const serverUrl = process.env.CRONOGPT_SMOKE_URL ?? `https://${defaultOracleDomain}/mcp`;
const token = process.env.CRONOGPT_API_TOKEN;
const browserWarmupTimeoutMs = Number(process.env.CRONOGPT_SMOKE_BROWSER_WARMUP_TIMEOUT_MS ?? 240000);
const browserProbeTimeoutMs = Number(process.env.CRONOGPT_SMOKE_BROWSER_TIMEOUT_MS ?? 180000);

if (!token) {
  throw new Error("Missing CRONOGPT_API_TOKEN.");
}

const checks = [];
const chatGptActionToolNames = [
  "get_daily_summary",
  "list_food_entries",
  "list_biometrics",
  "list_exercises",
  "list_notes",
  "log_food",
  "log_foods",
  "delete_diary_food_entry",
  "search_foods",
  "custom_food_nutrient_schema",
  "list_custom_foods",
  "find_duplicate_custom_foods",
  "create_custom_food",
  "create_and_log_custom_food",
  "update_custom_food",
  "delete_custom_food",
  "retire_custom_food",
  "list_private_recipe_names",
  "find_private_recipe",
  "resolve_recipe_ingredients",
  "ensure_private_recipe",
  "get_targets",
  "cronometer_runtime_status",
  "cronometer_stability_check",
  "refresh_cronometer_session",
];

const health = await fetch(serverUrl.replace(/\/mcp\/?$/, "/"));
const healthData = await health.json().catch(() => undefined);
checks.push({
  name: "health",
  ok: health.ok &&
    healthData?.name === "cronogpt" &&
    typeof healthData?.mode === "string",
  data: healthData,
});

await withClient(async (client) => {
  const tools = await client.listTools();
  const runtimeTool = tools.tools.find((tool) => tool.name === "cronometer_runtime_status");
  const runtimeSecuritySchemes = runtimeTool?._meta?.securitySchemes;
  const actionTools = chatGptActionToolNames.map((name) => tools.tools.find((tool) => tool.name === name));
  const missingActionTools = chatGptActionToolNames.filter((name, index) => !actionTools[index]);
  const templateBoundActionTools = actionTools
    .filter((tool) => tool && hasOutputTemplate(tool))
    .map((tool) => tool.name);
  checks.push({
    name: "tools",
    ok: tools.tools.length >= 50 &&
      tools.tools.some((tool) => tool.name === "cronometer_stability_check") &&
      tools.tools.some((tool) => tool.name === "run_cronometer_ui_flow") &&
      missingActionTools.length === 0 &&
      templateBoundActionTools.length === 0 &&
      Array.isArray(runtimeSecuritySchemes) &&
      runtimeSecuritySchemes.some((scheme) => scheme?.type === "oauth2"),
    data: {
      count: tools.tools.length,
      hasStabilityCheck: tools.tools.some((tool) => tool.name === "cronometer_stability_check"),
      hasUiFlow: tools.tools.some((tool) => tool.name === "run_cronometer_ui_flow"),
      missingActionTools,
      templateBoundActionTools,
      runtimeHasOauthMetadata: Array.isArray(runtimeSecuritySchemes) &&
        runtimeSecuritySchemes.some((scheme) => scheme?.type === "oauth2"),
    },
  });

  const runtime = await client.callTool({ name: "cronometer_runtime_status", arguments: {} });
  const runtimeData = runtime.structuredContent?.data;
  checks.push({
    name: "runtime",
    ok: runtime.structuredContent?.status === "ok" &&
      runtimeData?.storageStateConfigured === true &&
      runtimeData?.storageStateUsable !== false,
    data: runtimeData,
  });

  const dryRun = await client.callTool({
    name: "create_custom_food",
    arguments: {
      name: "cronogpt smoke test dry run",
      servingSize: "1 serving",
      nutrients: { calories: 1, net_carbs: 2, caffeine: 80, "omega-3 dha": 0.2, "20:5n3": 0.1, vitamin_c: 12 },
      dryRun: true,
      confirmed: false,
    },
  });
  const customFoodPreview = dryRun.structuredContent?.data?.preview;
  const customFoodPreviewLabels = customFoodPreview?.nutrients?.map((item) => item?.label) ?? [];
  checks.push({
    name: "custom_food_dry_run",
    ok: dryRun.structuredContent?.status === "dry_run" &&
      customFoodPreview?.servingSize?.parsed?.unit === "serving" &&
      customFoodPreviewLabels.includes("Energy") &&
      customFoodPreviewLabels.includes("Total Carbs") &&
      customFoodPreviewLabels.includes("Caffeine") &&
      customFoodPreviewLabels.includes("DHA") &&
      customFoodPreviewLabels.includes("EPA") &&
      customFoodPreviewLabels.includes("Vitamin C"),
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
      servingSize: "1 serving",
      nutrients: { calories: 123, protein: 4, net_carbs: 20, total_fat: 3 },
      nutritionSource: "smoke test fixture",
      meal: "Snacks",
      amount: 1,
      dryRun: true,
      confirmed: false,
    },
  });
  checks.push({
    name: "create_and_log_custom_food_dry_run",
    ok: createAndLogDryRun.structuredContent?.status === "dry_run" &&
      createAndLogDryRun.structuredContent?.data?.createCustomFood?.status === "dry_run" &&
      createAndLogDryRun.structuredContent?.data?.logFood?.status === "dry_run" &&
      createAndLogDryRun.structuredContent?.data?.logFood?.data?.normalized?.meal === "Snacks",
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
    ok: batchDryRun.structuredContent?.status === "dry_run" &&
      batchDryRun.structuredContent?.data?.browserOpened === false &&
      batchDryRun.structuredContent?.data?.writeAttempted === false &&
      batchDryRun.structuredContent?.data?.count === 2 &&
      batchDryRun.structuredContent?.data?.items?.[0]?.normalized?.meal === "Lunch" &&
      batchDryRun.structuredContent?.data?.items?.[1]?.normalized?.query === "milk 1%",
    data: {
      status: batchDryRun.structuredContent?.status,
      count: batchDryRun.structuredContent?.data?.count,
      items: batchDryRun.structuredContent?.data?.items,
      browserOpened: batchDryRun.structuredContent?.data?.browserOpened,
      writeAttempted: batchDryRun.structuredContent?.data?.writeAttempted,
    },
  });

  const recipeDryRun = await client.callTool({
    name: "create_recipe",
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
    ok: recipeDryRun.structuredContent?.status === "dry_run" &&
      recipeDryRun.structuredContent?.data?.preview?.recipeName === "cronogpt smoke test recipe dry run" &&
      Array.isArray(recipeDryRun.structuredContent?.data?.preview?.ingredients),
    data: {
      status: recipeDryRun.structuredContent?.status,
      feature: recipeDryRun.structuredContent?.feature,
      preview: recipeDryRun.structuredContent?.data?.preview,
    },
  });

  const dangerous = await client.callTool({
    name: "run_cronometer_ui_flow",
    arguments: {
      section: "account",
      steps: [{ action: "clickText", text: "Delete Account" }],
      dryRun: false,
      confirmed: true,
    },
  });
  checks.push({
    name: "dangerous_ui_block",
    ok: dangerous.structuredContent?.status === "needs_manual_step" &&
      /refuses dangerous/i.test(dangerous.structuredContent?.warning ?? ""),
    data: {
      status: dangerous.structuredContent?.status,
      warning: dangerous.structuredContent?.warning,
    },
  });

  const skipBrowserChecks = process.env.CRONOGPT_SMOKE_SKIP_BROWSER === "true" ||
    runtimeData?.loginPaused === true;
  if (skipBrowserChecks) {
    const reason = runtimeData?.loginPaused === true
      ? `Cronometer login is paused for ${runtimeData.loginPauseSecondsRemaining ?? "unknown"} seconds.`
      : "CRONOGPT_SMOKE_SKIP_BROWSER=true";
    checks.push({
      name: "stability",
      ok: true,
      skipped: true,
      data: { reason, runtime: runtimeData },
    });
    checks.push({
      name: "dated_food_dry_run",
      ok: true,
      skipped: true,
      data: { reason, runtime: runtimeData },
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
      date: diaryWarmup.structuredContent?.data?.date,
      dateStatus: diaryWarmup.structuredContent?.data?.dateStatus,
      summary: diaryWarmup.structuredContent?.data?.summary,
    },
  });

  const stability = await callTool(client, "cronometer_stability_check", {
    foodQuery: "Banana cream",
    includeFoodSearch: true,
  }, { timeout: browserProbeTimeoutMs });
  const stabilityLoginPaused = stability.structuredContent?.status === "needs_manual_step" &&
    stability.structuredContent?.data?.loginPauseSecondsRemaining > 0;
  checks.push({
    name: "stability",
    ok: stabilityLoginPaused ||
      stability.structuredContent?.status === "ok" &&
        stability.structuredContent?.data?.ready === true &&
        stability.structuredContent?.data?.checks?.hasMealSections === true,
    skipped: stabilityLoginPaused,
    data: stability.structuredContent?.data,
  });

  const datedFoodDryRun = await client.callTool({
    name: "log_food",
    arguments: {
      date: "today",
      meal: "Breakfast",
      query: "Banana cream",
      amount: 1,
      unit: "pint",
      dryRun: true,
      confirmed: false,
    },
  });
  checks.push({
    name: "dated_food_dry_run",
    ok: datedFoodDryRun.structuredContent?.status === "dry_run" &&
      datedFoodDryRun.structuredContent?.data?.browserOpened === false &&
      datedFoodDryRun.structuredContent?.data?.writeAttempted === false &&
      datedFoodDryRun.structuredContent?.data?.normalized?.query === "Banana cream",
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
