#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BrowserCronometerProvider,
  __exercisePageWriteAttemptMarkerForTests,
  __resetBrowserQueueForTests,
  __runBrowserQueueJobForTests,
  __setActiveBrowserJobForTests,
  releaseAndSnapshotBrowserQueue,
  providerResultDefinitelyDidNotWrite,
} from "../dist/providers/browser.js";
import { MockCronometerProvider } from "../dist/providers/mock.js";
import {
  APP_CALLABLE_READ_TOOLS,
  createCronoServer,
  MCP_SERVER_VERSION,
  STABLE_MODEL_VISIBLE_TOOLS,
  WIDGET_URI,
} from "../dist/mcp.js";
import { capabilitiesForMode } from "../dist/features.js";
import { isoDateInTimeZone, stableJson } from "../dist/determinism.js";
import {
  MCP_NEXT_ACTION_VALUES,
  MCP_OPERATION_STATE_VALUES,
  toMcpToolResponse,
} from "../dist/tool-response.js";
import { runCooldownCommand } from "./cronometer-login-cooldown.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "cronogpt-runtime-safety-"));
const cooldownFile = join(tempDir, "cooldown.json");
const operationJournalFile = join(tempDir, "operations.json");
const legacyOperationJournalFile = join(tempDir, "legacy-operations.json");
const failedOperationJournalFile = join(tempDir, "failed-operations.json");
const retentionOperationJournalFile = join(tempDir, "retention-operations.json");
const deleteOperationJournalFile = join(tempDir, "delete-operations.json");
const unresolvedDeleteOperationJournalFile = join(tempDir, "unresolved-delete-operations.json");
const fixedNow = Date.parse("2200-05-18T03:33:20.000Z");

try {
  const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const browserSource = readFileSync(new URL("../src/providers/browser.ts", import.meta.url), "utf8");
  assert.match(browserSource, /element\.getAttribute\("placeholder"\)/, "account verification must inspect Cronometer's email placeholder");
  assert.match(browserSource, /getByRole\("textbox", \{ name: \/\^Amount\$\/i \}\)/, "recipe ingredients must target Cronometer's labeled Amount field");
  assert.match(browserSource, /added_ingredient_not_verified/, "recipe creation must refuse Save when an amount does not read back");
  assert.equal(providerResultDefinitelyDidNotWrite({ provider: "browser", mode: "browser", feature: "delete", status: "needs_manual_step", data: { writeAttempted: false } }), true);
  assert.equal(providerResultDefinitelyDidNotWrite({ provider: "browser", mode: "browser", feature: "delete", status: "possibly_written_verify_failed", data: { writeAttempted: false } }), false);
  assert.deepEqual(__exercisePageWriteAttemptMarkerForTests({}), { marked: true, cleared: true });
  assert.equal(MCP_SERVER_VERSION, packageVersion, "MCP server identity must change whenever the app package version changes");

  let status = runCooldown(["status"]);
  assert.equal(status.active, false);
  assert.equal(status.filePath, cooldownFile);

  status = runCooldown(["set", "120", "Too", "Many", "Attempts"]);
  assert.equal(status.active, true);
  assert.equal(status.reason, "Too Many Attempts");
  assert.equal(status.secondsRemaining, 120);
  assert.equal(status.updatedAt, fixedNow);
  assert.equal(statSync(cooldownFile).mode & 0o777, 0o600);

  status = runCooldown(["clear"]);
  assert.equal(status.active, false);
  assert.equal(status.cleared, true);
  assert.equal(existsSync(cooldownFile), false);

  status = runCooldown(["set"], { CRONOMETER_LOGIN_BACKOFF_MS: "900000" });
  assert.equal(status.active, true);
  assert.equal(status.secondsRemaining, 900);

  assert.deepEqual([...STABLE_MODEL_VISIBLE_TOOLS], [
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
  ], "the default model surface must stay intentionally small and deterministic");
  assert.equal(STABLE_MODEL_VISIBLE_TOOLS.includes("get_targets"), false, "unstructured target scraping must not be ChatGPT-visible by default");
  const browserCapabilities = new Map(capabilitiesForMode("browser").map((capability) => [capability.id, capability.currentBackendStatus]));
  assert.equal(browserCapabilities.get("create_and_log_custom_food"), "ok");
  assert.equal(browserCapabilities.get("delete_diary_food_entry"), "ok");
  assert.equal(browserCapabilities.get("update_custom_recipe"), "ok");
  assert.equal(browserCapabilities.get("get_targets"), "needs_manual_step");

  const scopedServer = createCronoServer({ grantedScopes: ["cronometer:read"] });
  const scopedClient = new Client({ name: "cronogpt-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await scopedServer.connect(serverTransport);
  await scopedClient.connect(clientTransport);
  assert.equal(scopedClient.getServerVersion()?.version, MCP_SERVER_VERSION);
  const listedTools = await scopedClient.listTools();
  assert.equal(listedTools.tools.length, STABLE_MODEL_VISIBLE_TOOLS.length + 1, "default tools/list must contain only the stable model tools plus app-only capabilities");
  for (const toolName of STABLE_MODEL_VISIBLE_TOOLS) {
    const tool = listedTools.tools.find((candidate) => candidate.name === toolName);
    assert.ok(tool, `${toolName} must be present in tools/list`);
    const expectedVisibility = APP_CALLABLE_READ_TOOLS.includes(toolName) ? ["model", "app"] : ["model"];
    assert.deepEqual(tool._meta?.ui?.visibility, expectedVisibility, `${toolName} must have explicit least-privilege visibility`);
    for (const annotation of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof tool.annotations?.[annotation], "boolean", `${toolName}.${annotation} must be explicit`);
    }
  }
  const capabilityTool = listedTools.tools.find((tool) => tool.name === "cronometer_capabilities");
  assert.deepEqual(capabilityTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(listedTools.tools.some((tool) => tool.name === "delete_account"), false);
  assert.equal(listedTools.tools.some((tool) => tool.name === "run_cronometer_ui_flow"), false);
  assert.equal(listedTools.tools.some((tool) => tool.name === "create_recipe"), false);
  const dashboardTool = listedTools.tools.find((tool) => tool.name === "render_cronometer_dashboard");
  assert.equal(dashboardTool?._meta?.ui?.resourceUri, WIDGET_URI);
  assert.equal(dashboardTool?._meta?.["openai/outputTemplate"], WIDGET_URI);
  assert.match(WIDGET_URI, new RegExp(`v${MCP_SERVER_VERSION.replaceAll(".", "\\.")}\\.html$`));
  const resources = await scopedClient.listResources();
  const dashboardResource = resources.resources.find((resource) => resource.uri === WIDGET_URI);
  assert.ok(dashboardResource, "the versioned dashboard resource must be listed");
  const dashboardContents = await scopedClient.readResource({ uri: WIDGET_URI });
  assert.equal(dashboardContents.contents[0]?._meta?.ui?.prefersBorder, true);
  assert.equal(dashboardContents.contents[0]?._meta?.["openai/widgetPrefersBorder"], true);
  assert.match(dashboardContents.contents[0]?.text ?? "", /date: "today"/);
  const ensureRecipeTool = listedTools.tools.find((tool) => tool.name === "ensure_private_recipe");
  assert.ok(ensureRecipeTool?.inputSchema?.required?.includes("name"));
  assert.ok(ensureRecipeTool?.inputSchema?.required?.includes("ingredients"));
  assert.match(ensureRecipeTool?.description ?? "", /preferred recipe-writing workflow/i);
  assert.match(ensureRecipeTool?.description ?? "", /semantic match/i);
  const preferredCustomFoodTool = listedTools.tools.find((tool) => tool.name === "create_and_log_custom_food");
  assert.ok(preferredCustomFoodTool);
  assert.match(preferredCustomFoodTool.description ?? "", /preferred one-call workflow/i);
  assert.ok(preferredCustomFoodTool.inputSchema?.properties?.barcode);
  assert.ok(preferredCustomFoodTool.inputSchema?.required?.includes("meal"));
  assert.equal(preferredCustomFoodTool.annotations?.openWorldHint, false);
  assert.equal(preferredCustomFoodTool.annotations?.idempotentHint, true);
  const logFoodTool = listedTools.tools.find((tool) => tool.name === "log_food");
  assert.ok(logFoodTool?.inputSchema?.required?.includes("meal"));
  assert.deepEqual(logFoodTool?.inputSchema?.properties?.meal?.enum, ["Breakfast", "Lunch", "Dinner", "Snacks", "Supplements"]);
  assert.deepEqual(logFoodTool?.inputSchema?.properties?.matchPolicy?.enum, ["high_confidence", "selected_only"]);
  assert.ok(logFoodTool?.inputSchema?.properties?.portion, "log_food must expose explicit whole-package portion semantics");
  assert.match(logFoodTool?.description ?? "", /only initial tool call/i, "clear single-food requests should be one direct MCP call");
  assert.match(logFoodTool?.description ?? "", /do not preflight with search_foods, list_food_entries, or dryRun/i);
  assert.match(logFoodTool?.inputSchema?.properties?.dryRun?.description ?? "", /omit for a normal user-requested write/i);
  const listFoodEntriesTool = listedTools.tools.find((tool) => tool.name === "list_food_entries");
  assert.match(listFoodEntriesTool?.description ?? "", /do not call it as routine preflight/i);
  const logFoodsTool = listedTools.tools.find((tool) => tool.name === "log_foods");
  assert.ok(logFoodsTool?.inputSchema?.properties?.items?.items?.properties?.portion, "log_foods items must expose whole-package portions");
  const logFoodPlanTool = listedTools.tools.find((tool) => tool.name === "log_food_plan");
  assert.ok(logFoodPlanTool?.inputSchema?.required?.includes("items"));
  assert.ok(logFoodPlanTool?.inputSchema?.properties?.items?.items?.required?.includes("date"));
  assert.ok(logFoodPlanTool?.inputSchema?.properties?.items?.items?.required?.includes("meal"));
  assert.equal(logFoodPlanTool?.annotations?.idempotentHint, true);
  const operationTool = listedTools.tools.find((tool) => tool.name === "get_cronometer_operation");
  assert.ok(operationTool?.inputSchema?.required?.includes("operationId"));
  const deleteDiaryEntriesTool = listedTools.tools.find((tool) => tool.name === "delete_diary_food_entries");
  assert.equal(deleteDiaryEntriesTool?.annotations?.destructiveHint, true);
  assert.ok(deleteDiaryEntriesTool?.inputSchema?.properties?.items?.items?.required?.includes("confirmName"));
  assert.ok(deleteDiaryEntriesTool?.inputSchema?.properties?.idempotencyKey);
  assert.ok(deleteDiaryEntriesTool?.inputSchema?.properties?.items?.items?.properties?.idempotencyKey);
  assert.ok(deleteDiaryEntriesTool?.inputSchema?.properties?.items?.items?.properties?.expectedExistingMatchCount);
  assert.match(deleteDiaryEntriesTool?.description ?? "", /fresh plan idempotencyKey/i);
  const createCustomFoodTool = listedTools.tools.find((tool) => tool.name === "create_custom_food");
  const createAndLogTool = listedTools.tools.find((tool) => tool.name === "create_and_log_custom_food");
  assert.ok(createCustomFoodTool?.inputSchema?.required?.includes("nutrients"));
  assert.ok(createAndLogTool?.inputSchema?.required?.includes("meal"));
  assert.ok(createAndLogTool?.inputSchema?.required?.includes("nutrients"));
  assert.deepEqual(createAndLogTool?.inputSchema?.properties?.duplicatePolicy?.enum, ["fail", "update_existing"]);
  assert.equal(logFoodTool?.annotations?.openWorldHint, false);
  assert.equal(logFoodTool?.annotations?.idempotentHint, true);
  assert.match(scopedClient.getInstructions() ?? "", /barcode links the private custom food/i);
  assert.match(scopedClient.getInstructions() ?? "", /call log_food directly once/i);
  assert.ok(createCustomFoodTool?.inputSchema?.properties?.portions);
  assert.equal(createCustomFoodTool?.inputSchema?.required?.includes("servingSize"), false, "servingSize remains optional when custom-food portions supply the preferred 1 g base serving");
  assert.ok(createCustomFoodTool?.inputSchema?.properties?.expectedExistingMatchCount);
  assert.ok(createAndLogTool?.inputSchema?.properties?.portions);
  assert.equal(createAndLogTool?.inputSchema?.required?.includes("servingSize"), false);
  assert.ok(createAndLogTool?.inputSchema?.properties?.expectedExistingMatchCount);
  assert.ok(logFoodTool?.inputSchema?.properties?.expectedExistingMatchCount);
  assert.ok(logFoodsTool?.inputSchema?.properties?.expectedExistingMatchCount);
  const rejectedWrite = await scopedClient.callTool({
    name: "create_custom_food",
    arguments: {
      name: "scope test",
      servingSize: "1 serving",
      nutrients: { calories: 1 },
      barcode: "4006381333931",
      dryRun: true,
    },
  });
  assert.equal(rejectedWrite.structuredContent?.status, "error");
  assert.equal(rejectedWrite.structuredContent?.source, "oauth-scope-enforcement");
  for (const [name, arguments_] of [
    ["delete_custom_food", { name: "test food", confirmName: "test food", confirmed: true }],
    ["delete_custom_recipe", { name: "test recipe", confirmName: "test recipe", confirmed: true }],
    ["update_custom_recipe", { name: "test recipe", newName: "renamed recipe", confirmed: true }],
  ]) {
    const tool = listedTools.tools.find((candidate) => candidate.name === name);
    assert.deepEqual(tool._meta.securitySchemes, [{ type: "oauth2", scopes: ["cronometer:read", "cronometer:write"] }]);
    assert.equal(tool.annotations.destructiveHint, name.startsWith("delete_"));
    const denied = await scopedClient.callTool({ name, arguments: arguments_ });
    assert.equal(denied.structuredContent?.source, "oauth-scope-enforcement", `${name} must reject read-only tokens before calling the provider`);
  }
  await scopedClient.close();
  await scopedServer.close();

  const recipePreviewServer = createCronoServer({ grantedScopes: ["cronometer:read", "cronometer:write"] });
  const recipePreviewClient = new Client({ name: "cronogpt-recipe-preview-test", version: "1.0.0" });
  const [recipePreviewClientTransport, recipePreviewServerTransport] = InMemoryTransport.createLinkedPair();
  await recipePreviewServer.connect(recipePreviewServerTransport);
  await recipePreviewClient.connect(recipePreviewClientTransport);
  const recipePreview = await recipePreviewClient.callTool({
    name: "ensure_private_recipe",
    arguments: {
      name: "browser-free preview",
      ingredients: [{ query: "Banana", amount: 100, unit: "g" }],
      servings: 1,
      servingName: "serving",
      dryRun: true,
      confirmed: false,
    },
  });
  assert.equal(recipePreview.structuredContent?.feature, "ensure_private_recipe");
  assert.equal(recipePreview.structuredContent?.status, "dry_run");
  assert.equal(recipePreview.structuredContent?.data?.stage, "preview");
  assert.equal(recipePreview.structuredContent?.data?.browserOpened, false);
  assert.equal(recipePreview.structuredContent?.data?.writeAttempted, false);
  await recipePreviewClient.close();
  await recipePreviewServer.close();

  class MultiDayPlanProvider extends MockCronometerProvider {
    constructor() {
      super();
      this.foodGroups = [];
      this.deletes = [];
    }

    async logFoods(input) {
      this.foodGroups.push(input);
      return { provider: "multi-day-test", mode: "mock", feature: "log_foods", status: "written", data: { count: input.items.length } };
    }

    async deleteDiaryFoodEntry(input) {
      this.deletes.push(input);
      return { provider: "multi-day-test", mode: "mock", feature: "delete_diary_food_entry", status: "ok", data: { deleted: true } };
    }
  }

  const multiDayProvider = new MultiDayPlanProvider();
  const multiDayServer = createCronoServer({ grantedScopes: ["cronometer:read", "cronometer:write"], provider: multiDayProvider });
  const multiDayClient = new Client({ name: "cronogpt-multi-day-test", version: "1.0.0" });
  const [multiDayClientTransport, multiDayServerTransport] = InMemoryTransport.createLinkedPair();
  await multiDayServer.connect(multiDayServerTransport);
  await multiDayClient.connect(multiDayClientTransport);
  const foodPlan = await multiDayClient.callTool({
    name: "log_food_plan",
    arguments: {
      idempotencyKey: "test-plan",
      confirmed: true,
      items: [
        { date: "2026-07-16", meal: "Breakfast", query: "Banana", amount: 100, unit: "g" },
        { date: "2026-07-17", meal: "Lunch", query: "Milk", amount: 200, unit: "g" },
        { date: "2026-07-16", meal: "Breakfast", query: "Cocoa", amount: 20, unit: "g" },
      ],
    },
  });
  assert.equal(foodPlan.structuredContent?.status, "written");
  assert.equal(foodPlan.structuredContent?.data?.completed, true);
  assert.equal(multiDayProvider.foodGroups.length, 2);
  assert.deepEqual(multiDayProvider.foodGroups.map((group) => [group.date, group.meal, group.items.length]), [
    ["2026-07-16", "Breakfast", 2],
    ["2026-07-17", "Lunch", 1],
  ]);
  assert.equal(multiDayProvider.foodGroups[0].idempotencyKey, "test-plan:group:0");
  assert.equal(multiDayProvider.foodGroups[0].items[1].idempotencyKey, "test-plan:item:2");

  multiDayProvider.logFoods = async (input) => {
    multiDayProvider.foodGroups.push(input);
    return {
      provider: "multi-day-test",
      mode: "mock",
      feature: "log_foods",
      status: "needs_manual_step",
      data: { attemptedCount: 1, writeAttempted: false },
    };
  };
  const partialFoodPlan = await multiDayClient.callTool({
    name: "log_food_plan",
    arguments: {
      idempotencyKey: "partial-plan",
      confirmed: true,
      items: [
        { date: "2026-07-16", meal: "Breakfast", query: "One", amount: 1, unit: "g" },
        { date: "2026-07-16", meal: "Breakfast", query: "Two", amount: 2, unit: "g" },
        { date: "2026-07-17", meal: "Lunch", query: "Three", amount: 3, unit: "g" },
      ],
    },
  });
  assert.equal(partialFoodPlan.structuredContent?.status, "needs_manual_step");
  assert.equal(partialFoodPlan.structuredContent?.data?.attemptedCount, 1);
  assert.deepEqual(partialFoodPlan.structuredContent?.data?.remainingItemIndices, [1, 2]);

  const deletePlan = await multiDayClient.callTool({
    name: "delete_diary_food_entries",
    arguments: {
      idempotencyKey: "test-delete-plan",
      confirmed: true,
      items: [
        { date: "2026-07-16", meal: "Breakfast", name: "Banana", confirmName: "Banana", amount: 100, unit: "g", expectedExistingMatchCount: 1 },
        { date: "2026-07-17", meal: "Lunch", name: "Milk", confirmName: "Milk", amount: 200, unit: "g" },
      ],
    },
  });
  assert.equal(deletePlan.structuredContent?.status, "ok");
  assert.equal(deletePlan.structuredContent?.data?.completed, true);
  assert.equal(multiDayProvider.deletes.length, 2);
  assert.equal(multiDayProvider.deletes[0].dryRun, false);
  assert.equal(multiDayProvider.deletes[0].idempotencyKey, "test-delete-plan:item:0");
  assert.equal(multiDayProvider.deletes[1].idempotencyKey, "test-delete-plan:item:1");
  assert.equal(multiDayProvider.deletes[0].expectedExistingMatchCount, 1);

  const todayInDeletePlanTimeZone = isoDateInTimeZone(process.env.CRONOMETER_TIME_ZONE?.trim() || "Asia/Jerusalem");
  const overlappingDeletePlan = await multiDayClient.callTool({
    name: "delete_diary_food_entries",
    arguments: {
      idempotencyKey: "overlapping-delete-plan",
      confirmed: true,
      items: [
        { date: "today", meal: "Breakfast", name: "Orange Juice, Fresh", confirmName: "Orange Juice, Fresh", amount: 1, unit: "oz" },
        { date: todayInDeletePlanTimeZone, meal: "Breakfast", name: "orange juice, fresh", confirmName: "orange juice, fresh", amount: 1, unit: "ounce" },
      ],
    },
  });
  assert.equal(overlappingDeletePlan.structuredContent?.status, "needs_manual_step");
  assert.equal(overlappingDeletePlan.structuredContent?.data?.attemptedCount, 0);
  assert.equal(overlappingDeletePlan.structuredContent?.data?.writeAttempted, false);
  assert.deepEqual(overlappingDeletePlan.structuredContent?.data?.overlappingTargets, [{ indices: [0, 1] }]);
  assert.equal(multiDayProvider.deletes.length, 2, "overlapping delete plans must make zero provider calls");
  await multiDayClient.close();
  await multiDayServer.close();

  class RecipeWorkflowProvider extends MockCronometerProvider {
    constructor(recipes) {
      super();
      this.recipes = recipes;
      this.created = [];
      this.updated = [];
    }

    async listCustomRecipes(input) {
      const names = this.recipes.map((recipe) => recipe.name);
      return {
        provider: "recipe-workflow-test",
        mode: "mock",
        feature: "list_custom_recipes",
        status: "ok",
        data: { query: input.query, count: names.length, names, recipes: this.recipes, duplicateGroups: [] },
      };
    }

    async createRecipe(input) {
      this.created.push(input);
      return { provider: "recipe-workflow-test", mode: "mock", feature: "create_recipe", status: "ok", data: { recipe: input } };
    }

    async updateCustomRecipe(input) {
      this.updated.push(input);
      return { provider: "recipe-workflow-test", mode: "mock", feature: "update_custom_recipe", status: "ok", data: { update: input } };
    }
  }

  const runEnsureRecipe = async (recipeProvider, arguments_) => {
    const server = createCronoServer({
      grantedScopes: ["cronometer:read", "cronometer:write"],
      provider: recipeProvider,
    });
    const client = new Client({ name: "cronogpt-recipe-ensure-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await client.callTool({ name: "ensure_private_recipe", arguments: arguments_ });
    } finally {
      await client.close();
      await server.close();
    }
  };

  const targetRecipe = {
    name: "Reese's Protein Ice Cream Base",
    servings: 2,
    servingName: "Ninja Creami pint",
    ingredients: [
      { query: "Milk", selectedName: "Milk, 1% Fat, Lowfat", selectedSource: "NCCDB", amount: 600, unit: "g" },
      { query: "PB2", selectedName: "PB2, Powdered Peanut Butter, Original", selectedSource: "CRDB", amount: 26, unit: "g" },
    ],
    confirmed: true,
    dryRun: false,
  };
  const identicalProvider = new RecipeWorkflowProvider([{
    recipeId: "same-1",
    name: targetRecipe.name,
    servings: 2,
    servingName: "Ninja Creami pint",
    ingredientsStatus: "parsed",
    ingredients: [
      { name: "Milk, 1% Fat, Lowfat", database: "NCCDB", amount: 600, unit: "grams" },
      { name: "PB2, Powdered Peanut Butter, Original", database: "CRDB", amount: 26, unit: "g" },
    ],
  }]);
  const identicalRecipe = await runEnsureRecipe(identicalProvider, targetRecipe);
  assert.equal(identicalRecipe.structuredContent?.status, "already_exists");
  assert.equal(identicalRecipe.structuredContent?.data?.stage, "verified_existing");
  assert.equal(identicalProvider.created.length, 0);
  assert.equal(identicalProvider.updated.length, 0);

  const partialProvider = new RecipeWorkflowProvider([{
    recipeId: "partial-1",
    name: targetRecipe.name,
    servings: 2,
    servingName: "Ninja Creami pint",
    ingredientsStatus: "parsed",
    ingredients: [{ name: "Milk, 1% Fat, Lowfat", database: "NCCDB", amount: 600, unit: "g" }],
  }]);
  const repairedRecipe = await runEnsureRecipe(partialProvider, targetRecipe);
  assert.equal(repairedRecipe.structuredContent?.status, "ok");
  assert.equal(repairedRecipe.structuredContent?.data?.stage, "repair");
  assert.equal(partialProvider.created.length, 0);
  assert.equal(partialProvider.updated.length, 1);
  assert.deepEqual(partialProvider.updated[0].ingredientsToAdd, [targetRecipe.ingredients[1]]);
  assert.equal(partialProvider.updated[0].recipeId, "partial-1");

  const emptyProvider = new RecipeWorkflowProvider([{
    recipeId: "empty-1",
    name: targetRecipe.name,
    servings: 1,
    servingName: "Serving",
    ingredientsStatus: "empty_confirmed",
    ingredients: [],
  }]);
  const repairedEmptyRecipe = await runEnsureRecipe(emptyProvider, targetRecipe);
  assert.equal(repairedEmptyRecipe.structuredContent?.status, "ok");
  assert.equal(emptyProvider.updated.length, 1);
  assert.equal(emptyProvider.updated[0].servings, 2);
  assert.equal(emptyProvider.updated[0].servingName, "Ninja Creami pint");
  assert.deepEqual(emptyProvider.updated[0].ingredientsToAdd, targetRecipe.ingredients);

  const extractionFailureProvider = new RecipeWorkflowProvider([{
    recipeId: "unparsed-1",
    name: targetRecipe.name,
    servings: 2,
    servingName: "Ninja Creami pint",
    ingredientsStatus: "extraction_failed",
  }]);
  const extractionFailure = await runEnsureRecipe(extractionFailureProvider, targetRecipe);
  assert.equal(extractionFailure.structuredContent?.status, "needs_manual_step");
  assert.equal(extractionFailure.structuredContent?.data?.conflict, "ingredient_extraction_failed");
  assert.equal(extractionFailureProvider.updated.length, 0);

  const changedProvider = new RecipeWorkflowProvider([{
    recipeId: "changed-1",
    name: targetRecipe.name,
    servings: 2,
    servingName: "Ninja Creami pint",
    ingredientsStatus: "parsed",
    ingredients: [
      { name: "Milk, 1% Fat, Lowfat", database: "NCCDB", amount: 500, unit: "g" },
      { name: "PB2, Powdered Peanut Butter, Original", database: "CRDB", amount: 26, unit: "g" },
    ],
  }]);
  const changedRecipe = await runEnsureRecipe(changedProvider, targetRecipe);
  assert.equal(changedRecipe.structuredContent?.status, "needs_manual_step");
  assert.equal(changedRecipe.structuredContent?.data?.conflict, "semantic_mismatch");
  assert.equal(changedProvider.updated.length, 0);

  const newProvider = new RecipeWorkflowProvider([]);
  const createdRecipe = await runEnsureRecipe(newProvider, targetRecipe);
  assert.equal(createdRecipe.structuredContent?.status, "ok");
  assert.equal(createdRecipe.structuredContent?.data?.stage, "create");
  assert.equal(newProvider.created.length, 1);
  assert.equal(newProvider.updated.length, 0);

  const legacyIdempotencyKey = "legacy-orange-juice";
  const legacyBackgroundKey = `log_food:${createHash("sha256")
    .update(JSON.stringify({ idempotencyKey: legacyIdempotencyKey }))
    .digest("hex")
    .slice(0, 24)}`;
  writeFileSync(legacyOperationJournalFile, JSON.stringify({
    version: 2,
    operations: [{
      id: "bg_legacy_false_written",
      key: legacyBackgroundKey,
      feature: "log_food",
      status: "completed",
      startedAt: 1,
      updatedAt: 2,
      input: { query: "fresh orange juice", date: "2026-07-18", meal: "Breakfast", amount: 272, unit: "g" },
      result: {
        provider: "browser",
        mode: "browser",
        feature: "log_food",
        status: "written",
        data: { writeAttempted: true },
      },
    }],
  }), { mode: 0o600 });
  const legacyProvider = new BrowserCronometerProvider({
    localChromium: false,
    writeEnabled: true,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 1000,
    loginBackoffMs: 1000,
    operationJournalFile: legacyOperationJournalFile,
    operationTimeoutMs: 1000,
    browserRetryCount: 0,
    timeZone: "Asia/Jerusalem",
  });
  const legacyOperation = await legacyProvider.getOperation("bg_legacy_false_written");
  assert.equal(legacyOperation.status, "possibly_written_verify_failed");
  assert.equal(legacyOperation.data.state, "indeterminate");
  assert.match(legacyOperation.warning, /predates the persisted exact-date\/meal\/amount verifier/i);
  const legacyReplay = await legacyProvider.logFood({
    query: "fresh orange juice",
    date: "2026-07-18",
    meal: "Breakfast",
    amount: 272,
    unit: "g",
    idempotencyKey: legacyIdempotencyKey,
    confirmed: true,
    waitForCompletionSeconds: 0,
  });
  assert.equal(legacyReplay.status, "possibly_written_verify_failed");
  assert.equal(legacyReplay.data.operationId, "bg_legacy_false_written");
  assert.equal(legacyReplay.data.retryable, false);
  assert.equal(legacyReplay.data.nextAction, "inspect_diary");
  const migratedLegacyJournal = JSON.parse(readFileSync(legacyOperationJournalFile, "utf8"));
  assert.equal(migratedLegacyJournal.operations[0].status, "indeterminate");
  assert.equal(migratedLegacyJournal.operations[0].result, undefined, "legacy optimistic success evidence must not survive migration");

  const newestIdempotencyKey = "newest-operation-wins";
  const newestBackgroundKey = `log_food:${createHash("sha256")
    .update(JSON.stringify({ idempotencyKey: newestIdempotencyKey }))
    .digest("hex")
    .slice(0, 24)}`;
  const unknownFailedIdempotencyKey = "unknown-failed-operation";
  const unknownFailedBackgroundKey = `log_food:${createHash("sha256")
    .update(JSON.stringify({ idempotencyKey: unknownFailedIdempotencyKey }))
    .digest("hex")
    .slice(0, 24)}`;
  writeFileSync(failedOperationJournalFile, JSON.stringify({
    version: 2,
    operations: [
      {
        id: "bg_old_unknown_failure",
        key: newestBackgroundKey,
        feature: "log_food",
        status: "failed",
        startedAt: 1,
        updatedAt: 2,
        input: {},
        error: "process exited unexpectedly",
      },
      {
        id: "bg_new_verified_success",
        key: newestBackgroundKey,
        feature: "log_food",
        status: "completed",
        startedAt: 3,
        updatedAt: 4,
        input: {},
        effectVerifierVersion: 2,
        result: {
          provider: "browser",
          mode: "browser",
          feature: "log_food",
          status: "written",
          data: { writeAttempted: true },
        },
      },
      {
        id: "bg_latest_unknown_failure",
        key: unknownFailedBackgroundKey,
        feature: "log_food",
        status: "failed",
        startedAt: 5,
        updatedAt: 6,
        input: {},
        error: "unknown post-crash effect",
      },
    ],
  }), { mode: 0o600 });
  const failedJournalProvider = new BrowserCronometerProvider({
    localChromium: false,
    writeEnabled: true,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 1000,
    loginBackoffMs: 1000,
    operationJournalFile: failedOperationJournalFile,
    operationTimeoutMs: 1000,
    browserRetryCount: 0,
    timeZone: "Asia/Jerusalem",
  });
  const newestReplay = await failedJournalProvider.logFood({
    query: "banana",
    date: "2026-07-18",
    meal: "Breakfast",
    amount: 100,
    unit: "g",
    idempotencyKey: newestIdempotencyKey,
    confirmed: true,
    waitForCompletionSeconds: 0,
  });
  assert.equal(newestReplay.status, "written", "the newest same-key verified success must win over an older failed record");
  assert.equal(newestReplay.data.operationId, "bg_new_verified_success");
  assert.equal(newestReplay.data.returnedFromJournal, true);
  const unknownFailureReplay = await failedJournalProvider.logFood({
    query: "banana",
    date: "2026-07-18",
    meal: "Breakfast",
    amount: 100,
    unit: "g",
    idempotencyKey: unknownFailedIdempotencyKey,
    confirmed: true,
    waitForCompletionSeconds: 0,
  });
  assert.equal(unknownFailureReplay.status, "possibly_written_verify_failed");
  assert.equal(unknownFailureReplay.data.operationId, "bg_latest_unknown_failure");
  assert.equal(unknownFailureReplay.data.nextAction, "inspect_diary");
  const unknownFailurePoll = await failedJournalProvider.getOperation("bg_latest_unknown_failure");
  assert.equal(unknownFailurePoll.status, "possibly_written_verify_failed");
  assert.equal(unknownFailurePoll.data.state, "indeterminate");

  const testBackgroundKey = (feature, payload) => `${feature}:${createHash("sha256")
    .update(stableJson(payload))
    .digest("hex")
    .slice(0, 24)}`;
  const deleteSemanticPayload = {
    date: "2026-07-18",
    meal: "Breakfast",
    name: "journal orange juice",
    amount: 272,
    unit: "g",
    deleteCount: 1,
  };
  const deleteSemanticKey = testBackgroundKey("delete_diary_food_entry", deleteSemanticPayload);
  const explicitDeleteKeyA = "delete-intent-a";
  writeFileSync(deleteOperationJournalFile, JSON.stringify({
    version: 2,
    operations: [
      {
        id: "bg_legacy_verified_delete",
        key: deleteSemanticKey,
        feature: "delete_diary_food_entry",
        status: "completed",
        startedAt: 10,
        updatedAt: 11,
        input: {},
        canonicalPayload: stableJson(deleteSemanticPayload),
        semanticKey: deleteSemanticKey,
        effectVerifierVersion: 2,
        result: {
          provider: "browser",
          mode: "browser",
          feature: "delete_diary_food_entry",
          status: "ok",
          data: { deleted: true, writeAttempted: true },
        },
      },
      {
        id: "bg_explicit_verified_delete_a",
        key: testBackgroundKey("delete_diary_food_entry", { idempotencyKey: explicitDeleteKeyA }),
        feature: "delete_diary_food_entry",
        status: "completed",
        startedAt: 12,
        updatedAt: 13,
        input: {},
        canonicalPayload: stableJson(deleteSemanticPayload),
        callerIdempotencyKey: explicitDeleteKeyA,
        semanticKey: deleteSemanticKey,
        effectVerifierVersion: 2,
        result: {
          provider: "browser",
          mode: "browser",
          feature: "delete_diary_food_entry",
          status: "ok",
          data: { deleted: true, writeAttempted: true },
        },
      },
    ],
  }), { mode: 0o600 });
  const deleteJournalProvider = new BrowserCronometerProvider({
    localChromium: false,
    writeEnabled: true,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 1000,
    loginBackoffMs: 1000,
    operationJournalFile: deleteOperationJournalFile,
    operationTimeoutMs: 1000,
    browserRetryCount: 0,
    timeZone: "Asia/Jerusalem",
  });
  const deleteIntent = {
    date: "2026-07-18",
    meal: "Breakfast",
    name: "Journal Orange Juice",
    amount: 272,
    unit: "g",
    deleteCount: 1,
    confirmName: "Journal Orange Juice",
    confirmed: true,
    dryRun: false,
    waitForCompletionSeconds: 0,
  };
  const legacyDeleteReplay = await deleteJournalProvider.deleteDiaryFoodEntry(deleteIntent);
  assert.equal(legacyDeleteReplay.status, "needs_manual_step", "legacy derived delete keys must never replay stale ok as current evidence");
  assert.equal(legacyDeleteReplay.data.operationId, "bg_legacy_verified_delete");
  assert.equal(legacyDeleteReplay.data.writeAttempted, false);
  assert.equal(legacyDeleteReplay.data.nextAction, "use_new_idempotency_key");
  const explicitDeleteReplay = await deleteJournalProvider.deleteDiaryFoodEntry({ ...deleteIntent, idempotencyKey: explicitDeleteKeyA });
  assert.equal(explicitDeleteReplay.status, "ok", "the same explicit deletion intent key must replay its verified terminal result");
  assert.equal(explicitDeleteReplay.data.operationId, "bg_explicit_verified_delete_a");
  assert.equal(explicitDeleteReplay.data.returnedFromJournal, true);
  const newDeleteIntent = await deleteJournalProvider.deleteDiaryFoodEntry({ ...deleteIntent, idempotencyKey: "delete-intent-b" });
  assert.equal(newDeleteIntent.status, "accepted", "a distinct key for a new approved deletion intent must not return the old ok result");
  assert.notEqual(newDeleteIntent.data.operationId, "bg_explicit_verified_delete_a");

  const unresolvedDeleteSemanticPayload = {
    ...deleteSemanticPayload,
    name: "unresolved delete food",
  };
  const unresolvedDeleteSemanticKey = testBackgroundKey("delete_diary_food_entry", unresolvedDeleteSemanticPayload);
  writeFileSync(unresolvedDeleteOperationJournalFile, JSON.stringify({
    version: 2,
    operations: [{
      id: "bg_unresolved_delete",
      key: testBackgroundKey("delete_diary_food_entry", { idempotencyKey: "unresolved-delete-a" }),
      feature: "delete_diary_food_entry",
      status: "indeterminate",
      startedAt: 20,
      updatedAt: 21,
      input: {},
      canonicalPayload: stableJson(unresolvedDeleteSemanticPayload),
      callerIdempotencyKey: "unresolved-delete-a",
      semanticKey: unresolvedDeleteSemanticKey,
      effectVerifierVersion: 2,
      error: "process restarted after a possible Delete confirmation",
    }],
  }), { mode: 0o600 });
  const unresolvedDeleteProvider = new BrowserCronometerProvider({
    localChromium: false,
    writeEnabled: true,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 1000,
    loginBackoffMs: 1000,
    operationJournalFile: unresolvedDeleteOperationJournalFile,
    operationTimeoutMs: 1000,
    browserRetryCount: 0,
    timeZone: "Asia/Jerusalem",
  });
  const unresolvedDeleteIntent = {
    ...deleteIntent,
    name: "Unresolved Delete Food",
    confirmName: "Unresolved Delete Food",
  };
  const unsafeDeleteSupersession = await unresolvedDeleteProvider.deleteDiaryFoodEntry({
    ...unresolvedDeleteIntent,
    idempotencyKey: "unresolved-delete-b",
  });
  assert.equal(unsafeDeleteSupersession.status, "possibly_written_verify_failed");
  assert.equal(unsafeDeleteSupersession.data.operationId, "bg_unresolved_delete");
  const baselineGuardedDeleteSupersession = await unresolvedDeleteProvider.deleteDiaryFoodEntry({
    ...unresolvedDeleteIntent,
    idempotencyKey: "unresolved-delete-c",
    expectedExistingMatchCount: 1,
  });
  assert.equal(baselineGuardedDeleteSupersession.status, "accepted", "a new key plus a fresh baseline may supersede an unresolved delete");

  const recentBase = Date.now();
  const safelyTerminalHistory = Array.from({ length: 120 }, (_, index) => ({
    id: `bg_safe_terminal_${String(index).padStart(3, "0")}`,
    key: `safe:${index}`,
    feature: "log_food",
    status: "completed",
    startedAt: recentBase + index,
    updatedAt: recentBase + index,
    input: {},
    effectVerifierVersion: 2,
    result: {
      provider: "browser",
      mode: "browser",
      feature: "log_food",
      status: "needs_manual_step",
      data: { writeAttempted: false },
    },
  }));
  writeFileSync(retentionOperationJournalFile, JSON.stringify({
    version: 2,
    operations: [
      {
        id: "bg_old_unresolved_failed",
        key: "old-unresolved-failed",
        feature: "log_food",
        status: "failed",
        startedAt: 1,
        updatedAt: 1,
        input: {},
        error: "unknown effect",
      },
      {
        id: "bg_old_unresolved_completed",
        key: "old-unresolved-completed",
        feature: "log_food",
        status: "completed",
        startedAt: 2,
        updatedAt: 2,
        input: {},
        effectVerifierVersion: 2,
        result: {
          provider: "browser",
          mode: "browser",
          feature: "log_food",
          status: "possibly_written_verify_failed",
          data: { writeAttempted: true },
        },
      },
      ...safelyTerminalHistory,
    ],
  }), { mode: 0o600 });
  new BrowserCronometerProvider({
    localChromium: false,
    writeEnabled: true,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 1000,
    loginBackoffMs: 1000,
    operationJournalFile: retentionOperationJournalFile,
    operationTimeoutMs: 1000,
    browserRetryCount: 0,
    timeZone: "Asia/Jerusalem",
  });
  const retainedJournal = JSON.parse(readFileSync(retentionOperationJournalFile, "utf8"));
  const retainedIds = new Set(retainedJournal.operations.map((operation) => operation.id));
  assert.equal(retainedJournal.operations.length, 102, "only safely terminal history is capped; unresolved effects are retained in addition");
  assert.equal(retainedIds.has("bg_old_unresolved_failed"), true);
  assert.equal(retainedIds.has("bg_old_unresolved_completed"), true);

  const provider = new BrowserCronometerProvider({
    email: "test@example.com",
    password: "secret",
    storageState: undefined,
    localChromium: true,
    writeEnabled: true,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 1000,
    loginBackoffMs: 900000,
    loginBackoffFile: cooldownFile,
    operationJournalFile,
    operationTimeoutMs: 1000,
    browserRetryCount: 0,
    timeZone: "Asia/Jerusalem",
    reuseRemoteContext: false,
    reuseLocalBrowser: false,
  });
  const missingMealWrite = await provider.logFood({ query: "banana", amount: 1, unit: "g" });
  assert.equal(missingMealWrite.status, "needs_manual_step");
  assert.equal(missingMealWrite.data.browserOpened, false);
  assert.match(missingMealWrite.warning, /Unsupported meal/);

  const pausedWrite = await provider.logFood({ query: "banana", meal: "Lunch", amount: 1, unit: "g" });
  assert.equal(pausedWrite.status, "not_written_login_paused");
  assert.equal(pausedWrite.data.browserOpened, false);
  assert.equal(pausedWrite.data.writeAttempted, false);
  assert.ok(pausedWrite.data.loginPauseSecondsRemaining > 0);

  const invalidWrite = await provider.logFood({
    query: "banana",
    meal: "Brunch",
    date: "2026-02-29",
    timestamp: "13 PM",
  });
  assert.equal(invalidWrite.status, "needs_manual_step");
  assert.equal(invalidWrite.data.browserOpened, false);
  assert.equal(invalidWrite.data.writeAttempted, false);
  assert.match(invalidWrite.warning, /Unsupported meal/);

  const invalidRangeRead = await provider.listFoodEntries({ startDate: "2026-01-01" });
  assert.equal(invalidRangeRead.status, "needs_manual_step");
  assert.equal(invalidRangeRead.data.browserOpened, false);
  assert.match(invalidRangeRead.warning, /both startDate and endDate/);

  const invalidCustomFood = await provider.createCustomFood({
    name: "invalid nutrient food",
    servingSize: "1 serving",
    nutrients: { imaginary_nutrient: 1 },
    confirmed: true,
    dryRun: false,
  });
  assert.equal(invalidCustomFood.status, "needs_manual_step");
  assert.equal(invalidCustomFood.data.browserOpened, false);
  assert.match(invalidCustomFood.warning, /Unknown nutrient key/);

  // A label-based serving must flow into a selectable physical diary amount.
  // The real 45 g bar was created successfully but failed when logging the
  // caller's "1 serving", because Cronometer only offered the label's unit.
  for (const [servingSize, amount, unit, expectedAmount, expectedUnit] of [
    ["45 g", 1, "serving", 45, "g"],
    ["45 g", 2, "servings", 90, "g"],
    ["250 ml", undefined, undefined, 250, "ml"],
    ["100 g", 45, "g", 45, "g"],
  ]) {
    const preview = await provider.createAndLogCustomFood({
      name: "Label-serving regression food", servingSize,
      nutrients: { calories: 200 }, meal: "Snacks", date: "2026-10-14",
      amount, unit, dryRun: true,
    });
    assert.equal(preview.status, "dry_run");
    assert.equal(preview.data.logFood.data.normalized.amount, expectedAmount);
    assert.equal(preview.data.logFood.data.normalized.unit, expectedUnit);
    assert.equal(preview.data.logFood.data.browserOpened, false);
  }

  const pausedBatchWrite = await provider.logFoods({
    meal: "Lunch",
    items: [{ query: "banana", amount: 1, unit: "g" }],
  });
  assert.equal(pausedBatchWrite.status, "not_written_login_paused");
  assert.equal(pausedBatchWrite.data.browserOpened, false);
  assert.equal(pausedBatchWrite.data.writeAttempted, false);

  const pausedRead = await provider.stabilityCheck({ includeFoodSearch: false });
  assert.equal(pausedRead.status, "needs_manual_step");
  assert.equal(pausedRead.data.browserOpened, false);
  assert.equal(pausedRead.data.writeAttempted, false);

  const batchDryRun = await provider.logFoods({
    date: "today",
    meal: "Lunch",
    items: [
      { query: "Banana", amount: 100, unit: "g" },
      { query: "1% fat milk", amount: 62, unit: "grams" },
    ],
    dryRun: true,
    confirmed: false,
  });
  assert.equal(batchDryRun.status, "dry_run");
  assert.equal(batchDryRun.data.browserOpened, false);
  assert.equal(batchDryRun.data.writeAttempted, false);
  assert.equal(batchDryRun.data.count, 2);
  assert.equal(batchDryRun.data.items[0].normalized.meal, "Lunch");
  assert.equal(batchDryRun.data.items[1].normalized.query, "milk 1%");
  assert.equal(batchDryRun.data.items[1].normalized.unit, "g");

  const duplicateBatch = await provider.logFoods({
    meal: "Lunch",
    items: [
      { query: "Banana", amount: 1, unit: "serving" },
      { query: "banana", amount: 1, unit: "servings" },
    ],
    dryRun: true,
  });
  assert.equal(duplicateBatch.status, "needs_manual_step");
  assert.equal(duplicateBatch.data.browserOpened, false);
  assert.deepEqual(duplicateBatch.data.duplicateItems[0].indices, [0, 1]);

  const acceptedResponse = toMcpToolResponse({
    provider: "browser",
    mode: "browser",
    feature: "log_food",
    status: "accepted",
  });
  assert.equal(acceptedResponse.structuredContent.ok, false);
  assert.equal(acceptedResponse.structuredContent.completed, false);
  assert.equal(acceptedResponse.structuredContent.intentSatisfied, false);
  assert.equal(acceptedResponse.structuredContent.state, "running");
  assert.equal(acceptedResponse.structuredContent.retryable, false);
  assert.equal(acceptedResponse.structuredContent.nextAction, "poll");

  const dryRunResponse = toMcpToolResponse({
    provider: "mock",
    mode: "mock",
    feature: "log_food",
    status: "dry_run",
    data: { writeAttempted: false },
  });
  assert.equal(dryRunResponse.structuredContent.ok, false);
  assert.equal(dryRunResponse.structuredContent.completed, false);
  assert.equal(dryRunResponse.structuredContent.intentSatisfied, false);
  assert.equal(dryRunResponse.structuredContent.state, "succeeded");
  assert.equal(dryRunResponse.structuredContent.retryable, false);
  assert.equal(dryRunResponse.structuredContent.nextAction, "none");
  assert.match(dryRunResponse.content[0].text, /completed a preview/i);
  assert.match(acceptedResponse.content[0].text, /not complete/i);

  assert.deepEqual(MCP_OPERATION_STATE_VALUES, ["pending", "running", "succeeded", "failed", "indeterminate"]);
  assert.deepEqual(MCP_NEXT_ACTION_VALUES, [
    "none",
    "poll",
    "poll_operation",
    "inspect_diary",
    "retry_with_same_key",
    "manual_resolution",
    "repair_operation_journal",
    "use_new_idempotency_key",
  ]);
  const unresolvedOperationResponse = toMcpToolResponse({
    provider: "browser",
    mode: "browser",
    feature: "log_food",
    status: "possibly_written_verify_failed",
    data: { state: "completed", retryable: true, nextAction: "poll_operation", operationId: "bg_prior" },
  });
  assert.equal(unresolvedOperationResponse.structuredContent.state, "indeterminate");
  assert.equal(unresolvedOperationResponse.structuredContent.retryable, false);
  assert.equal(unresolvedOperationResponse.structuredContent.nextAction, "poll_operation");
  const journalFailureResponse = toMcpToolResponse({
    provider: "browser",
    mode: "browser",
    feature: "log_food",
    status: "error",
    data: { nextAction: "repair_operation_journal" },
  });
  assert.equal(journalFailureResponse.structuredContent.nextAction, "repair_operation_journal");
  const invalidMetadataResponse = toMcpToolResponse({
    provider: "browser",
    mode: "browser",
    feature: "log_food",
    status: "error",
    data: { state: "completed", retryable: "yes", nextAction: "invent_action", operationId: 123 },
  });
  assert.equal(invalidMetadataResponse.structuredContent.state, "failed");
  assert.equal(invalidMetadataResponse.structuredContent.retryable, false);
  assert.equal(invalidMetadataResponse.structuredContent.nextAction, "manual_resolution");
  assert.equal(invalidMetadataResponse.structuredContent.operationId, undefined);
  const redactedErrorResponse = toMcpToolResponse({
    provider: "browser",
    mode: "browser",
    feature: "search_foods",
    status: "error",
    warning: "connect wss://agent:super-secret@example.test/session?token=abc123 failed \u001b[31mnow\u001b[0m",
    data: { endpoint: "https://user:pass@example.test/path?api_key=secret-value" },
  });
  assert.equal(redactedErrorResponse.structuredContent.warning.includes("super-secret"), false);
  assert.equal(redactedErrorResponse.structuredContent.warning.includes("abc123"), false);
  assert.equal(redactedErrorResponse.content[0].text.includes("\u001b["), false);
  assert.equal(redactedErrorResponse.structuredContent.data.endpoint.includes("pass"), false);
  assert.equal(redactedErrorResponse.structuredContent.data.endpoint.includes("secret-value"), false);
  const busyResponse = toMcpToolResponse({
    provider: "browser",
    mode: "browser",
    feature: "search_foods",
    status: "busy",
  });
  assert.equal(busyResponse.structuredContent.state, "pending");
  assert.equal(busyResponse.structuredContent.retryable, true);
  assert.equal(busyResponse.structuredContent.nextAction, "retry_with_same_key");

  const mockProvider = new MockCronometerProvider({
    timeZone: "Asia/Jerusalem",
    clock: () => new Date("2026-07-18T12:00:00.000Z"),
  });
  const mockReadResult = await mockProvider.getDailySummary({ date: "2026-07-18" });
  assert.equal(mockReadResult.status, "ok");
  assert.equal(mockReadResult.source, "mock-fixture");
  const mockReadResponse = toMcpToolResponse(mockReadResult);
  assert.equal(mockReadResponse.structuredContent.ok, true);
  assert.equal(mockReadResponse.structuredContent.completed, true);
  assert.equal(mockReadResponse.structuredContent.state, "succeeded");
  const mockStabilityResult = await mockProvider.stabilityCheck({ includeFoodSearch: true });
  assert.equal(mockStabilityResult.status, "ok");
  assert.equal(mockStabilityResult.source, "mock-fixture");
  const mockResolutionResult = await mockProvider.resolveRecipeIngredients({
    recipeName: "Fixture recipe",
    ingredients: [{ query: "banana", amount: 100, unit: "g" }],
  });
  assert.equal(mockResolutionResult.status, "ok");
  assert.equal(mockResolutionResult.source, "mock-fixture");
  const mockWriteResult = await mockProvider.logFood({ query: "banana", meal: "Breakfast", amount: 100, unit: "g" });
  assert.equal(mockWriteResult.status, "dry_run");
  const ambiguousResponse = toMcpToolResponse({
    provider: "browser",
    mode: "browser",
    feature: "log_food",
    status: "not_written_ambiguous",
    warning: "Pick an exact result.",
  });
  assert.equal(ambiguousResponse.structuredContent.ok, false);
  assert.equal(ambiguousResponse.isError, false);

  assert.equal(provider.featureQueueWaitTimeoutMs("log_food"), 10000);
  assert.equal(provider.featureQueueWaitTimeoutMs("log_foods"), 10000);
  assert.equal(provider.featureQueueWaitTimeoutMs("search_foods"), 5000);
  const hostedProvider = new BrowserCronometerProvider({
    ...provider.config,
    operationTimeoutMs: 180000,
  });
  assert.equal(hostedProvider.featureQueueWaitTimeoutMs("log_food"), 180000);
  assert.equal(hostedProvider.featureQueueWaitTimeoutMs("log_foods"), 180000);
  assert.equal(hostedProvider.featureQueueWaitTimeoutMs("update_custom_recipe"), 180000);
  assert.equal(hostedProvider.featureQueueWaitTimeoutMs("delete_custom_recipe"), 180000);
  for (const method of ["updateCustomRecipe", "deleteCustomRecipe"]) {
    const refused = await hostedProvider[method]({ recipeId: "123", confirmed: true });
    assert.equal(refused.status, "needs_manual_step");
    assert.equal(refused.data.browserOpened, false, "an ID-only recipe mutation must refuse before scanning the library");
    assert.equal(refused.data.writeAttempted, false);
  }
  const recipeJobProvider = new BrowserCronometerProvider({
    ...provider.config,
    operationJournalFile: join(tempDir, "recipe-edit-jobs.json"),
  });
  // Keep the real admission, deduplication and durable completion machinery.
  // Only the slow browser edit and the initial response wait are stubbed.
  let finishRecipeEdit;
  let recipeEditRuns = 0;
  recipeJobProvider.runUpdateCustomRecipe = async () => {
    recipeEditRuns++;
    return new Promise((resolve) => { finishRecipeEdit = resolve; });
  };
  recipeJobProvider.waitForAcceptedBackgroundJob = async (_feature, accepted, seconds) => {
    assert.equal(seconds, 20, "recipe edits must return before the ChatGPT request timeout");
    return accepted;
  };
  const editInput = { name: "Existing recipe", recipeId: "123", newName: "New recipe name", confirmed: true };
  const pendingEdit = await recipeJobProvider.updateCustomRecipe(editInput);
  assert.equal(pendingEdit.status, "accepted");
  const duplicateEdit = await recipeJobProvider.updateCustomRecipe(editInput);
  assert.equal(duplicateEdit.data.operationId, pendingEdit.data.operationId);
  assert.equal(recipeEditRuns, 1, "a pending recipe edit must not be submitted twice");
  finishRecipeEdit({ provider: "browser", mode: "browser", feature: "update_custom_recipe", status: "ok", data: { updated: true } });
  await new Promise((resolve) => setImmediate(resolve));
  const finishedEdit = await recipeJobProvider.getOperation(pendingEdit.data.operationId);
  assert.equal(finishedEdit.status, "ok");
  assert.equal(finishedEdit.data.updated, true);
  const resumedRecipeJobs = new BrowserCronometerProvider(recipeJobProvider.config);
  const durableEdit = await resumedRecipeJobs.getOperation(pendingEdit.data.operationId);
  assert.equal(durableEdit.status, "ok", "recipe completion must survive a provider restart");
  assert.equal(hostedProvider.featureQueueWaitTimeoutMs("create_and_log_custom_food"), 180000);
  assert.equal(hostedProvider.featureQueueWaitTimeoutMs("delete_diary_food_entry"), 180000);

  status = runCooldown(["clear"]);
  assert.equal(status.active, false);

  writeFileSync(cooldownFile, "{not-json", { mode: 0o600 });
  status = runCooldown(["status"]);
  assert.equal(status.active, false);
  assert.equal(status.malformed, true);
  assert.match(status.reason, /Unreadable cooldown file/);

  __resetBrowserQueueForTests();
  __setActiveBrowserJobForTests("log_food", fixedNow - 10_000);
  let queue = releaseAndSnapshotBrowserQueue(60_000, fixedNow);
  assert.equal(queue.activeBrowserJobs, 1);
  assert.equal(queue.activeBrowserJob.feature, "log_food");

  queue = releaseAndSnapshotBrowserQueue(1, fixedNow);
  assert.equal(queue.activeBrowserJobs, 1);
  assert.equal(queue.activeBrowserJob.feature, "log_food");
  assert.equal(queue.staleActiveJob.feature, "log_food");
  __resetBrowserQueueForTests();

  const starts = [];
  let signalFirstStarted;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstCanFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = __runBrowserQueueJobForTests("first", async () => {
    starts.push("first");
    signalFirstStarted();
    await firstCanFinish;
    return "first";
  });
  await firstStarted;
  const second = __runBrowserQueueJobForTests("second", async () => {
    starts.push("second");
    return "second";
  });
  queue = releaseAndSnapshotBrowserQueue(1000);
  assert.equal(queue.activeBrowserJobs, 1);
  assert.equal(queue.queuedBrowserJobs, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(starts, ["first", "second"]);
  __resetBrowserQueueForTests();

  let releaseResetFirst;
  let signalResetFirstStarted;
  const resetFirstStarted = new Promise((resolve) => {
    signalResetFirstStarted = resolve;
  });
  const resetFirstCanFinish = new Promise((resolve) => {
    releaseResetFirst = resolve;
  });
  const resetFirst = __runBrowserQueueJobForTests("reset-first", async () => {
    signalResetFirstStarted();
    await resetFirstCanFinish;
    return "reset-first";
  });
  await resetFirstStarted;
  const resetQueued = __runBrowserQueueJobForTests("reset-queued", async () => "must-not-run");
  __resetBrowserQueueForTests();
  releaseResetFirst();
  assert.equal(await resetFirst, "reset-first");
  await assert.rejects(resetQueued, /queue was reset/);

  __resetBrowserQueueForTests();
  let releaseDeadlineBlocker;
  let signalDeadlineBlockerStarted;
  const deadlineBlockerStarted = new Promise((resolve) => { signalDeadlineBlockerStarted = resolve; });
  const deadlineBlockerCanFinish = new Promise((resolve) => { releaseDeadlineBlocker = resolve; });
  const deadlineBlocker = __runBrowserQueueJobForTests("deadline-blocker", async () => {
    signalDeadlineBlockerStarted();
    await deadlineBlockerCanFinish;
  });
  await deadlineBlockerStarted;
  const deadlineProvider = new BrowserCronometerProvider({
    localChromium: true,
    writeEnabled: false,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 100,
    loginBackoffMs: 100,
    operationTimeoutMs: 150,
    browserRetryCount: 0,
    timeZone: "Asia/Jerusalem",
  });
  deadlineProvider.newSession = async () => ({
    context: { storageState: async () => ({ cookies: [], origins: [] }) },
    page: {},
    closeContext: false,
    closeBrowser: false,
  });
  deadlineProvider.currentLoginBackoff = () => ({ until: 0, reason: undefined, source: "test" });
  const queuedDeadlineStartedAt = Date.now();
  const queuedDeadlineResultPromise = deadlineProvider.withPage("log_food", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { provider: "browser", mode: "browser", feature: "log_food", status: "ok" };
  });
  setTimeout(() => releaseDeadlineBlocker(), 100);
  const queuedDeadlineResult = await queuedDeadlineResultPromise;
  const queuedDeadlineElapsedMs = Date.now() - queuedDeadlineStartedAt;
  await deadlineBlocker;
  assert.equal(queuedDeadlineResult.status, "error");
  assert.match(queuedDeadlineResult.warning, /shared 150ms browser-operation deadline/i);
  assert.ok(queuedDeadlineElapsedMs < 230, `queue wait and handler must share 150ms, elapsed=${queuedDeadlineElapsedMs}`);
  __resetBrowserQueueForTests();

  console.log("runtime safety checks passed");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function runCooldown(args, env = {}) {
  return runCooldownCommand(args, {
    env: {
      ...env,
      CRONOMETER_LOGIN_BACKOFF_FILE: cooldownFile,
    },
    now: fixedNow,
  });
}
