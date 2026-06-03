import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createProviderFromEnv } from "./providers/index.js";
import { toMcpToolResponse } from "./tool-response.js";
import { CUSTOM_FOOD_NUTRIENT_SCHEMA, customFoodNutrientSchemaSummary } from "./nutrients.js";
import {
  authorizeMcpRequest,
  getAuthToken,
  handleOAuthRequest,
  rejectUnauthorized,
} from "./oauth.js";

const widgetHtml = readFileSync(join(process.cwd(), "public/cronometer-widget.html"), "utf8");
const widgetUri = "ui://widget/cronometer-dashboard.html";

const provider = createProviderFromEnv();

const dateRangeInputSchema = {
  date: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
};

const emptyInputSchema = {};

const commonOutputSchema = {
  ok: z.boolean(),
  provider: z.string(),
  mode: z.string(),
  feature: z.string(),
  status: z.string(),
  warning: z.string().optional(),
  source: z.string().optional(),
  data: z.unknown().optional(),
};

export const MCP_PATH = "/mcp";
const allToolSecuritySchemes = [{ type: "oauth2" as const, scopes: ["cronometer:read", "cronometer:write"] }];

export function createCronoServer() {
  const server = new McpServer({ name: "cronogpt", version: "0.1.2" });

  registerAppResource(
    server,
    "cronometer-dashboard",
    widgetUri,
    {
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
          domain: process.env.APP_PUBLIC_ORIGIN ?? "http://localhost:8787",
        },
        "openai/widgetDescription": "Cronometer tool status and result dashboard.",
      },
    },
    async () => ({
      contents: [
        {
          uri: widgetUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
        },
      ],
    }),
  );

  const register = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    annotations: Record<string, boolean>,
    handler: (args: Record<string, unknown>) => Promise<any>,
  ) => {
    const toolConfig = {
      title,
      description,
      inputSchema,
      outputSchema: commonOutputSchema,
      securitySchemes: allToolSecuritySchemes,
      annotations,
      _meta: {
        securitySchemes: allToolSecuritySchemes,
        ui: { resourceUri: widgetUri, visibility: ["model", "app"] },
        "openai/outputTemplate": widgetUri,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Running Cronometer tool...",
        "openai/toolInvocation/invoked": "Cronometer tool complete.",
      },
    };

    registerAppTool(
      server,
      name,
      toolConfig as Parameters<typeof registerAppTool>[2],
      async (args: unknown) => handler((args ?? {}) as Record<string, unknown>),
    );
  };

  const frameworkOnly = (feature: string, args: Record<string, unknown>, warning: string) => {
    const status = provider.mode === "mock" ? ("dry_run" as const) : ("needs_manual_step" as const);
    return toMcpToolResponse({
      provider: provider.name,
      mode: provider.mode,
      feature,
      status,
      data: { input: args },
      warning,
      source: "cronometer-ui-inventory",
    });
  };

  const parseCustomFoodFallbackScope = (scope: unknown):
    | { action: "delete"; foodId?: string; name: string; confirmName: string }
    | { action: "retire"; foodId?: string; name: string; retiredName?: string }
    | undefined => {
    if (typeof scope !== "string") return undefined;
    const value = scope.trim();
    if (!value) return undefined;

    const retireIdMatch = value.match(/^custom_food_id_retire:(\d+):(.+)$/i) ?? value.match(/^retire_custom_food_id:(\d+):(.+)$/i);
    if (retireIdMatch?.[1] && retireIdMatch[2]) {
      return { action: "retire", foodId: retireIdMatch[1], name: retireIdMatch[2].trim() };
    }

    const retireNameMatch = value.match(/^custom_food_retire:(.+)$/i) ?? value.match(/^retire_custom_food:(.+)$/i);
    if (retireNameMatch?.[1]) {
      return { action: "retire", name: retireNameMatch[1].trim() };
    }

    const idMatch = value.match(/^custom_food_id:(\d+):(.+)$/i) ?? value.match(/^custom_food#(\d+)\|(.+)$/i);
    if (idMatch?.[1] && idMatch[2]) {
      const name = idMatch[2].trim();
      return { action: "delete", foodId: idMatch[1], name, confirmName: name };
    }

    const nameMatch = value.match(/^custom_food:(.+)$/i);
    if (nameMatch?.[1]) {
      const name = nameMatch[1].trim();
      return { action: "delete", name, confirmName: name };
    }

    return undefined;
  };

  const registerFrameworkTool = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    annotations: Record<string, boolean>,
    warning: string,
  ) => {
    register(name, title, description, inputSchema, annotations, async (args) =>
      frameworkOnly(name, args, warning),
    );
  };

  const registerReadPageTool = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    hash: string,
  ) => {
    register(name, title, description, inputSchema, { readOnlyHint: true, openWorldHint: true }, async (args) =>
      toMcpToolResponse(await provider.readFeaturePage(name, hash, args)),
    );
  };

  const cronometerPageHashes: Record<string, string> = {
    diary: "#diary",
    customFoods: "#custom-foods",
    customMeals: "#custom-meals",
    customRecipes: "#custom-recipes",
    targetsProfile: "#profile",
    charts: "#charts",
    nutritionReport: "#nutrition-report",
    printReport: "#print-report",
    snapshots: "#snapshots",
    fasting: "#fasting",
    repeatItems: "#repeat-items",
    macroScheduler: "#macro-scheduler",
    displaySettings: "#display-settings",
    devices: "#devices",
    sharing: "#sharing",
    account: "#account",
  };

  register(
    "cronometer_capabilities",
    "Show Cronometer capabilities",
    "Shows which Cronometer features this connector can read, write, or only framework at the current backend setting.",
    emptyInputSchema,
    { readOnlyHint: true, openWorldHint: false },
    async () => toMcpToolResponse(await provider.capabilities()),
  );

  register(
    "cronometer_runtime_status",
    "Show connector runtime status",
    "Reports backend configuration, write mode, browser session state, and login cooldown without opening Cronometer.",
    emptyInputSchema,
    { readOnlyHint: true, openWorldHint: false },
    async () => toMcpToolResponse(await provider.runtimeStatus()),
  );

  register(
    "custom_food_nutrient_schema",
    "Show custom food nutrient schema",
    "Returns the canonical nutrient keys, Cronometer display labels, units, and aliases accepted by create_custom_food. Use this before writing detailed custom foods.",
    emptyInputSchema,
    { readOnlyHint: true, openWorldHint: false },
    async () => toMcpToolResponse({
      provider: provider.name,
      mode: provider.mode,
      feature: "custom_food_nutrient_schema",
      status: "ok",
      data: {
        nutrients: CUSTOM_FOOD_NUTRIENT_SCHEMA,
        summary: customFoodNutrientSchemaSummary(),
        writeFormat: "create_custom_food.nutrients accepts any schema key, any listed alias, or an exact Cronometer display label as a numeric value in the label's Cronometer unit.",
      },
    }),
  );

  register(
    "refresh_cronometer_session",
    "Refresh Cronometer browser session",
    "Opens Cronometer once to verify login and warm the hosted browser storage cache. Does not write diary data.",
    emptyInputSchema,
    { readOnlyHint: true, openWorldHint: true },
    async () => toMcpToolResponse(await provider.refreshSession()),
  );

  register(
    "cronometer_stability_check",
    "Run Cronometer stability check",
    "Read-only preflight that verifies hosted Cronometer login, Diary readability, and optional food search before a workflow.",
    {
      foodQuery: z.string().optional(),
      includeFoodSearch: z.boolean().optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.stabilityCheck(args)),
  );

  register(
    "read_cronometer_page",
    "Read Cronometer page",
    "Reads visible text from a major Cronometer page as a fallback when a specialized parser is not enough.",
    {
      section: z.enum([
        "diary",
        "customFoods",
        "customMeals",
        "customRecipes",
        "targetsProfile",
        "charts",
        "nutritionReport",
        "printReport",
        "snapshots",
        "fasting",
        "repeatItems",
        "macroScheduler",
        "displaySettings",
        "devices",
        "sharing",
        "account",
      ]),
      ...dateRangeInputSchema,
      hint: z.string().optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    async (args) => {
      const section = String(args.section);
      return toMcpToolResponse(await provider.readFeaturePage("read_cronometer_page", cronometerPageHashes[section] ?? "#diary", args));
    },
  );

  register(
    "run_cronometer_ui_flow",
    "Run Cronometer UI flow",
    "Runs a constrained sequence of visible-text UI steps inside Cronometer for workflows that do not have a specialized tool yet. Use dryRun=true first; execution requires confirmed=true.",
    {
      section: z.enum([
        "diary",
        "customFoods",
        "customMeals",
        "customRecipes",
        "targetsProfile",
        "charts",
        "nutritionReport",
        "printReport",
        "snapshots",
        "fasting",
        "repeatItems",
        "macroScheduler",
        "displaySettings",
        "devices",
        "sharing",
        "account",
      ]),
      steps: z.array(
        z.object({
          action: z.enum(["clickText", "fillLabel", "fillPlaceholder", "press", "wait", "read"]),
          text: z.string().optional(),
          label: z.string().optional(),
          placeholder: z.string().optional(),
          value: z.string().optional(),
          key: z.enum(["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp"]).optional(),
          ms: z.number().int().nonnegative().max(5000).optional(),
          exact: z.boolean().optional(),
        }),
      ).max(20),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.runUiFlow(args as never)),
  );

  register(
    "get_daily_summary",
    "Get daily nutrition summary",
    "Reads a Cronometer daily nutrition summary for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.getDailySummary(args)),
  );

  register(
    "list_food_entries",
    "List food entries",
    "Lists Cronometer food and recipe diary entries for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.listFoodEntries(args)),
  );

  register(
    "list_biometrics",
    "List biometrics",
    "Lists Cronometer biometric entries for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.listBiometrics(args)),
  );

  register(
    "list_exercises",
    "List exercises",
    "Lists Cronometer exercise entries for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.listExercises(args)),
  );

  register(
    "list_notes",
    "List notes",
    "Lists Cronometer diary notes for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.listNotes(args)),
  );

  register(
    "search_foods",
    "Search foods",
    "Searches for Cronometer food matches. Browser implementation must be verified before real use.",
    { query: z.string().min(1), limit: z.number().int().positive().max(25).optional() },
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.searchFoods({ query: String(args.query), limit: args.limit as number | undefined })),
  );

  register(
    "resolve_recipe_ingredients",
    "Resolve recipe ingredients",
    "Optionally searches Cronometer for each recipe ingredient when the user wants to review exact food/source choices before creating a custom recipe. For a small straightforward recipe, create_recipe can be called directly with ingredient query, amount, unit, confirmed=true, and dryRun=false.",
    {
      recipeName: z.string().optional(),
      ingredients: z.array(
        z.object({
          query: z.string().min(1),
          selectedName: z.string().optional(),
          selectedSource: z.string().optional().describe("Optional Cronometer result source from resolve_recipe_ingredients, such as CRDB, NCCDB, USDA, Custom Food, or Brand."),
          amount: z.number().positive().optional(),
          unit: z.string().optional(),
        }),
      ),
      limitPerIngredient: z.number().int().positive().max(5).optional(),
      maxSeconds: z.number().int().positive().max(900).optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    async (args) => {
      return toMcpToolResponse(
        await provider.resolveRecipeIngredients({
          recipeName: args.recipeName as string | undefined,
          ingredients: args.ingredients as Array<{ query: string; selectedName?: string; selectedSource?: string; amount?: number; unit?: string }>,
          limitPerIngredient: args.limitPerIngredient as number | undefined,
          maxSeconds: args.maxSeconds as number | undefined,
        }),
      );
    },
  );

  register(
    "log_food",
    "Log food",
    "Adds a food to the Cronometer diary. For explicit food-log requests, writes directly when server writes are enabled. Use dryRun=true only for previews or ambiguity.",
    {
      date: z.string().optional(),
      meal: z.string().optional(),
      query: z.string().min(1),
      selectedName: z.string().optional(),
      amount: z.number().positive().optional(),
      unit: z.string().optional(),
      timestamp: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.logFood(args as never)),
  );

  register(
    "log_exercise",
    "Log exercise",
    "Adds an exercise to the Cronometer diary. Requires user confirmation before real writes.",
    {
      date: z.string().optional(),
      name: z.string().min(1),
      minutes: z.number().positive().optional(),
      calories: z.number().positive().optional(),
      timestamp: z.string().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.logExercise(args as never)),
  );

  register(
    "log_biometric",
    "Log biometric",
    "Adds a biometric value to the Cronometer diary. Requires user confirmation before real writes.",
    {
      date: z.string().optional(),
      metric: z.string().min(1),
      value: z.number(),
      unit: z.string().optional(),
      timestamp: z.string().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.logBiometric(args as never)),
  );

  register(
    "log_note",
    "Log note",
    "Adds a note to the Cronometer diary. Requires user confirmation before real writes.",
    {
      date: z.string().optional(),
      note: z.string().min(1),
      timestamp: z.string().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.logNote(args as never)),
  );

  register(
    "create_custom_food",
    "Create custom food",
    "Creates or updates a custom Cronometer food after validation and confirmation. nutrients accepts keys from custom_food_nutrient_schema, aliases such as calories/carbs/valine/glycine/vitamin_c, or exact Cronometer display labels.",
    {
      name: z.string().min(1),
      servingSize: z.string().optional(),
      nutrients: z.record(z.number()).optional().describe("Numeric nutrient values. Keys may be canonical schema keys, aliases, or exact Cronometer labels; call custom_food_nutrient_schema for supported macronutrients, micronutrients, amino acids, fatty acids, vitamins, and minerals."),
      barcode: z.string().optional(),
      duplicatePolicy: z.enum(["fail", "update_existing", "create_new"]).optional().describe("Defaults to update_existing for exactly one same-named food, fails on multiple matches, and creates only when no match exists. Use create_new only when a duplicate is intentional."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.createCustomFood(args as never)),
  );

  register(
    "list_custom_foods",
    "List custom foods",
    "Lists Cronometer Foods > Custom Foods with structured names and optional detail extraction including foodId, serving size, energy, macros, and nutrient rows.",
    {
      query: z.string().optional(),
      includeDetails: z.boolean().optional(),
      maxDetails: z.number().int().nonnegative().max(25).optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.listCustomFoods(args as never)),
  );

  register(
    "find_duplicate_custom_foods",
    "Find duplicate custom foods",
    "Finds custom foods with matching or similar names and returns IDs plus nutrient summaries so a user can choose a safe update/delete target.",
    {
      name: z.string().min(1),
      maxDetails: z.number().int().positive().max(30).optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.findDuplicateCustomFoods(args as never)),
  );

  register(
    "update_custom_food",
    "Update custom food",
    "Updates one existing Cronometer custom food by exact foodId or unique exact name. Never creates a new custom food.",
    {
      foodId: z.string().optional(),
      name: z.string().optional().describe("Current exact custom food name. If multiple foods match, foodId is required."),
      newName: z.string().optional(),
      servingSize: z.string().optional(),
      nutrients: z.record(z.number()).optional().describe("Numeric nutrient values using custom_food_nutrient_schema keys, aliases, or exact Cronometer labels."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.updateCustomFood(args as never)),
  );

  register(
    "delete_custom_food",
    "Delete custom food",
    "Deletes one existing Cronometer custom food by exact foodId or unique exact name. Requires confirmed=true and confirmName matching the selected food name.",
    {
      foodId: z.string().optional(),
      name: z.string().optional(),
      confirmName: z.string().optional(),
      ifUsed: z.enum(["stop", "retire", "force"]).optional().describe("Defaults to stop. Use retire to rename instead if Cronometer warns that old diary entries use this food; use force only after explicit user approval."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.deleteCustomFood(args as never)),
  );

  register(
    "retire_custom_food",
    "Retire custom food",
    "Renames one existing Cronometer custom food instead of deleting it. Use when old diary entries may depend on the food.",
    {
      foodId: z.string().optional(),
      name: z.string().optional(),
      retiredName: z.string().optional().describe("Optional exact replacement name. Defaults to 'Retired - <name> - YYYY-MM-DD'."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.retireCustomFood(args as never)),
  );

  registerFrameworkTool(
    "create_custom_meal",
    "Create custom meal",
    "Creates a reusable Cronometer custom meal after validation and confirmation.",
    {
      name: z.string().min(1),
      items: z.array(
        z.object({
          query: z.string().min(1),
          amount: z.number().positive().optional(),
          unit: z.string().optional(),
        }),
      ),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    "Custom Meals exists in the live Cronometer UI, but the browser write flow still needs selector verification.",
  );

  registerReadPageTool(
    "list_custom_meals",
    "List custom meals",
    "Lists Cronometer Foods > Custom Meals.",
    emptyInputSchema,
    "#custom-meals",
  );

  register(
    "list_custom_recipes",
    "List custom recipes",
    "Lists Cronometer Foods > Custom Recipes with structured visible names and duplicate groups.",
    {
      query: z.string().optional(),
      includeDetails: z.boolean().optional(),
      maxDetails: z.number().int().nonnegative().max(25).optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.listCustomRecipes(args as never)),
  );

  register(
    "create_recipe",
    "Create recipe",
    "Creates and verifies a custom Cronometer recipe after user confirmation. For straightforward ingredients, pass query, amount, and unit directly; the browser provider auto-selects high-confidence official Cronometer matches. Use selectedName and selectedSource only when the user or resolve_recipe_ingredients picked a specific match. Ambiguous low-confidence searches are returned without writing.",
    {
      name: z.string().min(1),
      ingredients: z.array(
        z.object({
          query: z.string().min(1),
          selectedName: z.string().optional(),
          selectedSource: z.string().optional().describe("Optional Cronometer result source from resolve_recipe_ingredients, such as CRDB, NCCDB, USDA, Custom Food, or Brand."),
          amount: z.number().positive().optional(),
          unit: z.string().optional(),
        }),
      ),
      servings: z.number().positive().optional(),
      servingName: z.string().optional(),
      cookedWeight: z.number().positive().optional().describe("Optional total cooked/final recipe weight."),
      cookedWeightUnit: z.string().optional().describe("Unit for cookedWeight, such as g or oz."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.createRecipe(args as never)),
  );

  register(
    "delete_custom_recipe",
    "Delete custom recipe",
    "Deletes one existing Cronometer custom recipe by exact recipeId or unique exact name. Requires confirmed=true and confirmName matching the selected recipe name. Use ifUsed='retire' only if Cronometer warns that old diary entries depend on the recipe.",
    {
      recipeId: z.string().optional(),
      name: z.string().optional(),
      confirmName: z.string().optional(),
      ifUsed: z.enum(["stop", "retire", "force"]).optional().describe("Defaults to stop. Use retire to rename instead if Cronometer warns that old diary entries use this recipe; use force only after explicit user approval."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.deleteCustomRecipe(args as never)),
  );

  register(
    "update_custom_recipe",
    "Update custom recipe",
    "Updates one existing Cronometer custom recipe by exact recipeId or unique exact name. Can edit basics/cooked weight and add resolved ingredients without creating a duplicate.",
    {
      recipeId: z.string().optional(),
      name: z.string().optional().describe("Current exact custom recipe name. If multiple recipes match, recipeId is required."),
      newName: z.string().optional(),
      ingredientsToAdd: z.array(
        z.object({
          query: z.string().min(1),
          selectedName: z.string().optional(),
          selectedSource: z.string().optional().describe("Optional Cronometer result source from resolve_recipe_ingredients, such as CRDB, NCCDB, USDA, Custom Food, or Brand."),
          amount: z.number().positive().optional(),
          unit: z.string().optional(),
        }),
      ).optional(),
      servings: z.number().positive().optional(),
      servingName: z.string().optional(),
      cookedWeight: z.number().positive().optional(),
      cookedWeightUnit: z.string().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.updateCustomRecipe(args as never)),
  );

  register(
    "retire_custom_recipe",
    "Retire custom recipe",
    "Renames one existing Cronometer custom recipe instead of deleting it.",
    {
      recipeId: z.string().optional(),
      name: z.string().optional(),
      retiredName: z.string().optional().describe("Optional exact replacement name. Defaults to 'Retired - <name> - YYYY-MM-DD'."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.retireCustomRecipe(args as never)),
  );

  register(
    "get_targets",
    "Get targets",
    "Reads Cronometer calorie, macro, or nutrient targets.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.getTargets(args)),
  );

  registerReadPageTool(
    "get_profile",
    "Get profile",
    "Reads Cronometer Targets + Profile settings.",
    emptyInputSchema,
    "#profile",
  );

  registerFrameworkTool(
    "set_profile",
    "Set profile",
    "Updates Cronometer profile fields. Requires confirmation before real writes.",
    { fields: z.record(z.unknown()), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    "Profile updates are browser-only in this scaffold and must be confirmed before enabling.",
  );

  register(
    "set_targets",
    "Set targets",
    "Updates Cronometer calorie, macro, or nutrient targets. Requires user confirmation before real writes.",
    {
      date: z.string().optional(),
      targets: z.record(z.number()).optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.setTargets(args as never)),
  );

  register(
    "export_data",
    "Export data",
    "Starts or describes a Cronometer data export for servings, exercises, biometrics, notes, or fasting data.",
    {
      ...dateRangeInputSchema,
      include: z.array(z.enum(["servings", "exercises", "biometrics", "notes", "fasting"])).optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.exportData(args as never)),
  );

  registerReadPageTool(
    "get_charts",
    "Get charts",
    "Reads Cronometer Trends > Charts configuration or chart data.",
    { ...dateRangeInputSchema, chart: z.string().optional() },
    "#charts",
  );

  registerReadPageTool(
    "get_nutrition_report",
    "Get nutrition report",
    "Reads Cronometer Trends > Nutrition Report for a date range.",
    dateRangeInputSchema,
    "#nutrition-report",
  );

  registerReadPageTool(
    "get_print_report",
    "Get print report",
    "Prepares Cronometer Trends > Print Report for a date range.",
    dateRangeInputSchema,
    "#print-report",
  );

  registerReadPageTool(
    "list_snapshots",
    "List snapshots",
    "Lists Cronometer Trends > Snapshots.",
    emptyInputSchema,
    "#snapshots",
  );

  registerFrameworkTool(
    "create_snapshot",
    "Create snapshot",
    "Creates a Cronometer snapshot after confirmation.",
    { name: z.string().optional(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    "Snapshot creation is browser-only in this scaffold and must be confirmed before enabling.",
  );

  register(
    "start_fast",
    "Start fast",
    "Starts a Cronometer fast. Requires user confirmation before real writes.",
    {
      date: z.string().optional(),
      startTime: z.string().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.startFast(args as never)),
  );

  register(
    "stop_fast",
    "Stop fast",
    "Stops a Cronometer fast. Requires user confirmation before real writes.",
    {
      date: z.string().optional(),
      endTime: z.string().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.stopFast(args as never)),
  );

  register(
    "schedule_repeat_item",
    "Schedule repeat item",
    "Schedules a repeated Cronometer food, meal, or recipe entry. Requires user confirmation before real writes.",
    {
      sourceEntryId: z.string().optional(),
      query: z.string().optional(),
      meal: z.string().optional(),
      schedule: z.string().min(1),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.scheduleRepeatItem(args as never)),
  );

  registerReadPageTool(
    "list_repeat_items",
    "List repeat items",
    "Lists Cronometer Foods > Repeat Items.",
    emptyInputSchema,
    "#repeat-items",
  );

  registerFrameworkTool(
    "ask_oracle",
    "Ask Oracle",
    "Asks Cronometer's Oracle feature for food suggestions.",
    { question: z.string().min(1), dryRun: z.boolean().optional() },
    { readOnlyHint: true, openWorldHint: true },
    "Ask the Oracle exists in the live UI; selectors and account-tier behavior still need verification.",
  );

  registerFrameworkTool(
    "suggest_food",
    "Suggest food",
    "Submits a Cronometer food suggestion after confirmation.",
    { name: z.string().min(1), notes: z.string().optional(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    "Suggest Food exists in the live UI; submission flow must be verified before enabling.",
  );

  registerReadPageTool(
    "get_macro_scheduler",
    "Get macro scheduler",
    "Reads Cronometer More > Macro Scheduler.",
    emptyInputSchema,
    "#macro-scheduler",
  );

  registerFrameworkTool(
    "set_macro_scheduler",
    "Set macro scheduler",
    "Updates Cronometer macro scheduling rules after confirmation.",
    { schedule: z.record(z.unknown()), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    "Macro Scheduler writes are browser-only in this scaffold and must be confirmed before enabling.",
  );

  registerReadPageTool(
    "get_display_settings",
    "Get display settings",
    "Reads Cronometer More > Display Settings.",
    emptyInputSchema,
    "#display-settings",
  );

  registerFrameworkTool(
    "set_display_settings",
    "Set display settings",
    "Updates Cronometer display settings after confirmation.",
    { settings: z.record(z.unknown()), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    "Display setting writes are browser-only in this scaffold and must be confirmed before enabling.",
  );

  registerReadPageTool(
    "list_devices",
    "List devices",
    "Lists Cronometer More > Sync a Device integrations.",
    emptyInputSchema,
    "#devices",
  );

  registerFrameworkTool(
    "connect_device",
    "Connect device",
    "Starts a Cronometer device connection flow after confirmation.",
    { providerName: z.string().min(1), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    "Device connection opens third-party auth flows; this must stay user-confirmed.",
  );

  registerReadPageTool(
    "get_sharing",
    "Get sharing",
    "Reads Cronometer More > Sharing settings.",
    emptyInputSchema,
    "#sharing",
  );

  registerFrameworkTool(
    "set_sharing",
    "Set sharing",
    "Updates Cronometer sharing settings after confirmation.",
    { settings: z.record(z.unknown()), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    "Sharing writes affect access to health data and must stay explicitly confirmed.",
  );

  registerReadPageTool(
    "get_account",
    "Get account",
    "Reads non-secret Cronometer account settings.",
    emptyInputSchema,
    "#account",
  );

  register(
    "bulk_delete_entries",
    "Bulk delete entries",
    "Dangerous delete fallback. For custom foods only, pass scope='custom_food:<exact name>' or scope='custom_food_id:<foodId>:<exact name>'. Safer retire fallback: scope='custom_food_retire:<exact name>'. Other bulk deletes remain disabled.",
    { scope: z.string().optional(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async (args) => {
      const target = parseCustomFoodFallbackScope(args.scope);
      if (target) {
        if (target.action === "retire") {
          return toMcpToolResponse(await provider.retireCustomFood({
            foodId: target.foodId,
            name: target.name,
            retiredName: target.retiredName,
            dryRun: args.dryRun as boolean | undefined,
            confirmed: args.confirmed as boolean | undefined,
          }));
        }
        return toMcpToolResponse(await provider.deleteCustomFood({
          foodId: target.foodId,
          name: target.name,
          confirmName: target.confirmName,
          dryRun: args.dryRun as boolean | undefined,
          confirmed: args.confirmed as boolean | undefined,
        }));
      }
      return frameworkOnly(
        "bulk_delete_entries",
        args,
        "Bulk delete is disabled. The only enabled fallback is custom food delete with scope='custom_food:<exact name>' or scope='custom_food_id:<foodId>:<exact name>', or safer retire with scope='custom_food_retire:<exact name>'.",
      );
    },
  );

  registerFrameworkTool(
    "delete_account",
    "Delete account",
    "Dangerous framework stub for account deletion.",
    { dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    "Account deletion is intentionally not implemented.",
  );

  return server;
}

export async function handleMcpHttpRequest(req: IncomingMessage, res: ServerResponse) {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (await handleOAuthRequest(req, res, url)) {
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        name: "cronogpt",
        provider: provider.name,
        mode: provider.mode,
        mcp: MCP_PATH,
        authConfigured: Boolean(getAuthToken()),
      }));
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const auth = authorizeMcpRequest(req);
    if (!auth.ok) {
      rejectUnauthorized(req, res, auth.reason ?? "Unauthorized.");
      return;
    }

    const server = createCronoServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
}

export function createCronoHttpServer() {
  return createServer(handleMcpHttpRequest);
}
