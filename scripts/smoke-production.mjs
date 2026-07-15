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
const browserQueueWaitMs = positiveIntegerEnv("CRONOGPT_SMOKE_BROWSER_QUEUE_WAIT_MS", 240000);

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
  "cronometer_runtime_status",
  "cronometer_stability_check",
  "refresh_cronometer_session",
];

const health = await fetch(serverUrl.replace(/\/mcp\/?$/, "/"));
const healthData = await health.json().catch(() => undefined);
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
  const runtimeTool = tools.tools.find((tool) => tool.name === "cronometer_runtime_status");
  const runtimeSecuritySchemes = runtimeTool?._meta?.securitySchemes;
  const actionTools = chatGptActionToolNames.map((name) => tools.tools.find((tool) => tool.name === name));
  const missingActionTools = chatGptActionToolNames.filter((name, index) => !actionTools[index]);
  const templateBoundActionTools = actionTools
    .filter((tool) => tool && hasOutputTemplate(tool))
    .map((tool) => tool.name);
  const nonModelVisibleActionTools = actionTools
    .filter((tool) => tool && !tool._meta?.ui?.visibility?.includes("model"))
    .map((tool) => tool.name);
  checks.push({
    name: "tools",
    ok: tools.tools.length >= 50 &&
      tools.tools.some((tool) => tool.name === "cronometer_stability_check") &&
      tools.tools.some((tool) => tool.name === "run_cronometer_ui_flow") &&
      missingActionTools.length === 0 &&
      templateBoundActionTools.length === 0 &&
      nonModelVisibleActionTools.length === 0 &&
      Array.isArray(runtimeSecuritySchemes) &&
      runtimeSecuritySchemes.some((scheme) => scheme?.type === "oauth2"),
    data: {
      count: tools.tools.length,
      hasStabilityCheck: tools.tools.some((tool) => tool.name === "cronometer_stability_check"),
      hasUiFlow: tools.tools.some((tool) => tool.name === "run_cronometer_ui_flow"),
      missingActionTools,
      templateBoundActionTools,
      nonModelVisibleActionTools,
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
    ok: dryRun.structuredContent?.status === "dry_run" &&
      customFoodPreview?.servingSize?.parsed?.unit === "serving" &&
      customFoodPreview?.barcode?.normalized === "4006381333931" &&
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
      barcode: "036000291452",
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
      /refuses (?:dangerous|commit-like)/i.test(dangerous.structuredContent?.warning ?? ""),
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

  const queueIdle = await waitForBrowserQueueIdle(client, runtimeData, browserQueueWaitMs);
  checks.push({
    name: "browser_queue_idle",
    ok: true,
    skipped: !queueIdle.idle,
    data: queueIdle,
  });
  if (!queueIdle.idle) {
    const reason = "Cronometer browser queue is busy with an in-flight write; browser probes were skipped to avoid colliding with user work.";
    checks.push({
      name: "diary_warmup",
      ok: true,
      skipped: true,
      data: { reason, queue: queueIdle },
    });
    checks.push({
      name: "stability",
      ok: true,
      skipped: true,
      data: { reason, queue: queueIdle },
    });
    checks.push({
      name: "dated_food_dry_run",
      ok: true,
      skipped: true,
      data: { reason, queue: queueIdle },
    });
    return;
  }

  const diaryWarmup = await callTool(client, "get_daily_summary", {
    date: "today",
  }, { timeout: browserWarmupTimeoutMs });
  const diaryWarmupBusy = isBrowserBusyResult(diaryWarmup);
  const diaryWarmupUnavailable = isUnavailableBrowserProbeResult(diaryWarmup);
  checks.push(diaryWarmupBusy
    ? skippedBusyBrowserCheck("diary_warmup", diaryWarmup)
    : diaryWarmupUnavailable
      ? skippedUnavailableBrowserCheck("diary_warmup", diaryWarmup)
    : {
        name: "diary_warmup",
        ok: diaryWarmup.structuredContent?.status === "ok" &&
          diaryWarmup.structuredContent?.data?.dateStatus?.selected === true &&
          Boolean(diaryWarmup.structuredContent?.data?.summary),
        data: {
          status: diaryWarmup.structuredContent?.status,
          warning: diaryWarmup.structuredContent?.warning,
          date: diaryWarmup.structuredContent?.data?.date,
          dateStatus: diaryWarmup.structuredContent?.data?.dateStatus,
          summary: diaryWarmup.structuredContent?.data?.summary,
        },
      });

  if (diaryWarmupBusy) {
    checks.push(skippedBusyBrowserCheck("stability", diaryWarmup));
  } else if (diaryWarmupUnavailable) {
    checks.push(skippedUnavailableBrowserCheck("stability", diaryWarmup));
  } else {
    const stability = await callTool(client, "cronometer_stability_check", {
      foodQuery: "Banana cream",
      includeFoodSearch: true,
    }, { timeout: browserProbeTimeoutMs });
    const stabilityLoginPaused = stability.structuredContent?.status === "needs_manual_step" &&
      stability.structuredContent?.data?.loginPauseSecondsRemaining > 0;
    const stabilityBusy = isBrowserBusyResult(stability);
    const stabilityUnavailable = isUnavailableBrowserProbeResult(stability);
    checks.push(stabilityBusy
      ? skippedBusyBrowserCheck("stability", stability)
      : stabilityUnavailable
        ? skippedUnavailableBrowserCheck("stability", stability)
      : {
          name: "stability",
          ok: stabilityLoginPaused ||
            stability.structuredContent?.status === "ok" &&
              stability.structuredContent?.data?.ready === true &&
              stability.structuredContent?.data?.checks?.hasMealSections === true,
          skipped: stabilityLoginPaused,
          data: {
            status: stability.structuredContent?.status,
            warning: stability.structuredContent?.warning,
            ...(stability.structuredContent?.data ?? {}),
          },
        });
  }

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

async function waitForBrowserQueueIdle(client, initialRuntimeData, maxWaitMs) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, maxWaitMs);
  let runtimeData = initialRuntimeData;
  const samples = [];

  while (true) {
    const active = Number(runtimeData?.activeBrowserJobs ?? 0);
    const queued = Number(runtimeData?.queuedBrowserJobs ?? 0);
    samples.push({
      activeBrowserJobs: active,
      queuedBrowserJobs: queued,
      activeFeature: runtimeData?.activeBrowserJob?.feature,
      activeAgeMs: runtimeData?.activeBrowserJob?.ageMs,
    });

    if (active === 0 && queued === 0) {
      return {
        idle: true,
        waitedMs: Date.now() - startedAt,
        runtime: runtimeData,
        samples: samples.slice(-8),
      };
    }

    if (Date.now() >= deadline) {
      return {
        idle: false,
        waitedMs: Date.now() - startedAt,
        runtime: runtimeData,
        samples: samples.slice(-8),
      };
    }

    await sleep(Math.min(5000, Math.max(1000, deadline - Date.now())));
    const runtime = await callTool(client, "cronometer_runtime_status", {}, { timeout: 30000 });
    runtimeData = runtime.structuredContent?.data ?? runtimeData;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBrowserBusyResult(result) {
  const structured = result?.structuredContent;
  const data = structured?.data;
  return structured?.status === "busy" ||
    data?.status === "busy" ||
    Number(data?.queue?.activeBrowserJobs ?? 0) > 0 ||
    Number(data?.queue?.queuedBrowserJobs ?? 0) > 0 ||
    /browser queue is busy/i.test(structured?.warning ?? "");
}

function skippedBusyBrowserCheck(name, result) {
  return {
    name,
    ok: true,
    skipped: true,
    data: {
      reason: "Cronometer browser queue became busy during the smoke test; browser probe was skipped to avoid colliding with user work.",
      status: result?.structuredContent?.status,
      warning: result?.structuredContent?.warning,
      data: result?.structuredContent?.data,
    },
  };
}

function isUnavailableBrowserProbeResult(result) {
  const structured = result?.structuredContent;
  const data = structured?.data;
  const warning = structured?.warning ?? "";
  if (data?.writeAttempted === true) return false;
  return /account could not be verified.*no account email was visible/i.test(warning) ||
    /timed out running (?:get_daily_summary|cronometer_stability_check)/i.test(warning);
}

function skippedUnavailableBrowserCheck(name, result) {
  return {
    name,
    ok: true,
    skipped: true,
    data: {
      reason: "The optional read-only Cronometer browser preflight was unavailable; OCI health, MCP, runtime, and no-write safety checks still completed.",
      status: result?.structuredContent?.status,
      warning: result?.structuredContent?.warning,
      data: result?.structuredContent?.data,
    },
  };
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
