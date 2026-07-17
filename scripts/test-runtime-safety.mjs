#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BrowserCronometerProvider,
  __resetBrowserQueueForTests,
  __runBrowserQueueJobForTests,
  __setActiveBrowserJobForTests,
  releaseAndSnapshotBrowserQueue,
  providerResultDefinitelyDidNotWrite,
} from "../dist/providers/browser.js";
import { MockCronometerProvider } from "../dist/providers/mock.js";
import { createCronoServer, MCP_SERVER_VERSION, STABLE_MODEL_VISIBLE_TOOLS } from "../dist/mcp.js";
import { capabilitiesForMode } from "../dist/features.js";
import { toMcpToolResponse } from "../dist/tool-response.js";
import { runCooldownCommand } from "./cronometer-login-cooldown.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "cronogpt-runtime-safety-"));
const cooldownFile = join(tempDir, "cooldown.json");
const operationJournalFile = join(tempDir, "operations.json");
const fixedNow = Date.parse("2200-05-18T03:33:20.000Z");

try {
  const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const browserSource = readFileSync(new URL("../src/providers/browser.ts", import.meta.url), "utf8");
  assert.match(browserSource, /element\.getAttribute\("placeholder"\)/, "account verification must inspect Cronometer's email placeholder");
  assert.match(browserSource, /getByRole\("textbox", \{ name: \/\^Amount\$\/i \}\)/, "recipe ingredients must target Cronometer's labeled Amount field");
  assert.match(browserSource, /added_ingredient_not_verified/, "recipe creation must refuse Save when an amount does not read back");
  assert.equal(providerResultDefinitelyDidNotWrite({ provider: "browser", mode: "browser", feature: "delete", status: "needs_manual_step", data: { writeAttempted: false } }), true);
  assert.equal(providerResultDefinitelyDidNotWrite({ provider: "browser", mode: "browser", feature: "delete", status: "possibly_written_verify_failed", data: { writeAttempted: false } }), false);
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

  for (const toolName of [
    "get_daily_summary",
    "list_food_entries",
    "list_biometrics",
    "list_exercises",
    "list_notes",
    "log_food_plan",
    "delete_diary_food_entries",
    "list_custom_foods",
    "find_duplicate_custom_foods",
    "list_private_recipe_names",
    "find_private_recipe",
    "list_custom_recipes",
    "resolve_recipe_ingredients",
    "ensure_private_recipe",
    "create_recipe",
    "update_custom_recipe",
    "delete_custom_recipe",
    "retire_custom_recipe",
  ]) {
    assert.ok(STABLE_MODEL_VISIBLE_TOOLS.includes(toolName), `${toolName} should be ChatGPT-visible by default`);
  }
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
  for (const toolName of STABLE_MODEL_VISIBLE_TOOLS) {
    const tool = listedTools.tools.find((candidate) => candidate.name === toolName);
    assert.ok(tool, `${toolName} must be present in tools/list`);
    assert.deepEqual(tool._meta?.ui?.visibility, ["model"], `${toolName} must be explicitly model-visible`);
  }
  const ensureRecipeTool = listedTools.tools.find((tool) => tool.name === "ensure_private_recipe");
  assert.ok(ensureRecipeTool?.inputSchema?.required?.includes("name"));
  assert.ok(ensureRecipeTool?.inputSchema?.required?.includes("ingredients"));
  assert.match(ensureRecipeTool?.description ?? "", /preferred recipe-writing workflow/i);
  assert.match(ensureRecipeTool?.description ?? "", /semantic match/i);
  const updateRecipeTool = listedTools.tools.find((tool) => tool.name === "update_custom_recipe");
  assert.deepEqual(updateRecipeTool?._meta?.ui?.visibility, ["model"]);
  const resolveRecipeTool = listedTools.tools.find((tool) => tool.name === "resolve_recipe_ingredients");
  assert.match(resolveRecipeTool?.description ?? "", /ensure_private_recipe/);
  const directCreateRecipeTool = listedTools.tools.find((tool) => tool.name === "create_recipe");
  assert.deepEqual(directCreateRecipeTool?._meta?.ui?.visibility, ["model"]);
  assert.match(directCreateRecipeTool?.description ?? "", /only after find_private_recipe has confirmed/i);
  const deleteRecipeTool = listedTools.tools.find((tool) => tool.name === "delete_custom_recipe");
  assert.deepEqual(deleteRecipeTool?._meta?.ui?.visibility, ["model"]);
  assert.equal(deleteRecipeTool?.annotations?.destructiveHint, true);
  assert.match(deleteRecipeTool?.description ?? "", /default behavior is to click Cronometer's native Retire action/i);
  assert.match(deleteRecipeTool?.description ?? "", /native Retire action/i);
  assert.match(deleteRecipeTool?.inputSchema?.properties?.ifUsed?.description ?? "", /defaults to retire/i);
  const retireRecipeTool = listedTools.tools.find((tool) => tool.name === "retire_custom_recipe");
  assert.match(retireRecipeTool?.description ?? "", /native Retire action/i);
  assert.equal(retireRecipeTool?.inputSchema?.properties?.retiredName, undefined);
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
  const logFoodsTool = listedTools.tools.find((tool) => tool.name === "log_foods");
  assert.ok(logFoodsTool?.inputSchema?.properties?.items?.items?.properties?.portion, "log_foods items must expose whole-package portions");
  const logFoodPlanTool = listedTools.tools.find((tool) => tool.name === "log_food_plan");
  assert.ok(logFoodPlanTool?.inputSchema?.required?.includes("items"));
  assert.ok(logFoodPlanTool?.inputSchema?.properties?.items?.items?.required?.includes("date"));
  assert.ok(logFoodPlanTool?.inputSchema?.properties?.items?.items?.required?.includes("meal"));
  assert.equal(logFoodPlanTool?.annotations?.idempotentHint, true);
  const operationTool = listedTools.tools.find((tool) => tool.name === "get_cronometer_operation");
  assert.ok(operationTool?.inputSchema?.required?.includes("operationId"));
  const deleteDiaryTool = listedTools.tools.find((tool) => tool.name === "delete_diary_food_entry");
  assert.ok(deleteDiaryTool?.inputSchema?.properties?.deleteCount);
  const deleteDiaryEntriesTool = listedTools.tools.find((tool) => tool.name === "delete_diary_food_entries");
  assert.equal(deleteDiaryEntriesTool?.annotations?.destructiveHint, true);
  assert.ok(deleteDiaryEntriesTool?.inputSchema?.properties?.items?.items?.required?.includes("confirmName"));
  const createCustomFoodTool = listedTools.tools.find((tool) => tool.name === "create_custom_food");
  const createAndLogTool = listedTools.tools.find((tool) => tool.name === "create_and_log_custom_food");
  assert.ok(createCustomFoodTool?.inputSchema?.required?.includes("nutrients"));
  assert.ok(createAndLogTool?.inputSchema?.required?.includes("meal"));
  assert.ok(createAndLogTool?.inputSchema?.required?.includes("nutrients"));
  assert.deepEqual(createAndLogTool?.inputSchema?.properties?.duplicatePolicy?.enum, ["fail", "update_existing"]);
  assert.equal(logFoodTool?.annotations?.openWorldHint, false);
  assert.equal(logFoodTool?.annotations?.idempotentHint, true);
  assert.match(scopedClient.getInstructions() ?? "", /barcode links the private custom food/i);
  assert.ok(createCustomFoodTool?.inputSchema?.properties?.portions);
  assert.equal(createCustomFoodTool?.inputSchema?.required?.includes("servingSize"), false, "servingSize remains optional when custom-food portions supply the preferred 1 g base serving");
  assert.ok(createCustomFoodTool?.inputSchema?.properties?.expectedExistingMatchCount);
  assert.ok(createAndLogTool?.inputSchema?.properties?.portions);
  assert.equal(createAndLogTool?.inputSchema?.required?.includes("servingSize"), false);
  assert.ok(createAndLogTool?.inputSchema?.properties?.expectedExistingMatchCount);
  assert.ok(logFoodTool?.inputSchema?.properties?.expectedExistingMatchCount);
  assert.ok(logFoodsTool?.inputSchema?.properties?.expectedExistingMatchCount);
  assert.ok(deleteDiaryTool?.inputSchema?.properties?.deleteCount);
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
      confirmed: true,
      items: [
        { date: "2026-07-16", meal: "Breakfast", name: "Banana", confirmName: "Banana", amount: 100, unit: "g" },
        { date: "2026-07-17", meal: "Lunch", name: "Milk", confirmName: "Milk", amount: 200, unit: "g" },
      ],
    },
  });
  assert.equal(deletePlan.structuredContent?.status, "ok");
  assert.equal(deletePlan.structuredContent?.data?.completed, true);
  assert.equal(multiDayProvider.deletes.length, 2);
  assert.equal(multiDayProvider.deletes[0].dryRun, false);
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
  assert.match(acceptedResponse.content[0].text, /not complete/i);
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
