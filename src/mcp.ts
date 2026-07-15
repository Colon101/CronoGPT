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
import { validateBarcode } from "./barcode.js";
import { FOOD_LOG_MEALS, isValidFoodLogDate, parseFoodLogTimestamp } from "./food-log-transaction.js";
import {
  authorizeMcpRequest,
  getAuthToken,
  handleOAuthRequest,
  rejectUnauthorized,
} from "./oauth.js";

const widgetHtml = readFileSync(join(process.cwd(), "public/cronometer-widget.html"), "utf8");
const widgetUri = "ui://widget/cronometer-dashboard.html";

const provider = createProviderFromEnv();

const dateValueInputSchema = z.string()
  .refine((value) => {
    const normalized = value.trim().toLowerCase();
    return ["today", "yesterday", "tomorrow"].includes(normalized) || isValidFoodLogDate(value.trim());
  }, { message: "Use YYYY-MM-DD, today, yesterday, or tomorrow." });
const dateRangeInputSchema = {
  date: dateValueInputSchema.optional().describe("One diary date. Do not combine with startDate or endDate."),
  startDate: dateValueInputSchema.optional().describe("Inclusive range start. Requires endDate; omit date."),
  endDate: dateValueInputSchema.optional().describe("Inclusive range end. Requires startDate; omit date."),
};

const emptyInputSchema = {};

const commonOutputSchema = {
  ok: z.boolean(),
  completed: z.boolean(),
  intentSatisfied: z.boolean(),
  provider: z.string(),
  mode: z.enum(["mock", "terra", "browser"]),
  feature: z.string(),
  status: z.enum([
    "ok",
    "dry_run",
    "accepted",
    "written",
    "already_exists",
    "busy",
    "not_written_login_paused",
    "not_written_ambiguous",
    "not_written_not_found",
    "possibly_written_verify_failed",
    "not_configured",
    "unsupported",
    "needs_manual_step",
    "error",
  ]),
  warning: z.string().optional(),
  source: z.string().optional(),
  data: z.unknown().optional(),
};

const nutrientRecordSchema = z.record(
  z.number().finite().nonnegative(),
).describe("Numeric nutrient values in the units returned by custom_food_nutrient_schema. Values must be finite and non-negative.");
const nonEmptyNutrientRecordSchema = nutrientRecordSchema.refine(
  (nutrients) => Object.keys(nutrients).length > 0,
  { message: "Provide at least one nutrient from the package label." },
);
const barcodeInputSchema = z.string()
  .min(1)
  .max(64)
  .refine((value) => validateBarcode(value).valid, {
    message: "Use a valid 8-digit UPC-E/EAN-8, 12-digit UPC-A, 13-digit EAN-13, or 14-digit GTIN-14 barcode, including its check digit.",
  })
  .describe("Barcode printed on the package. Spaces and hyphens are normalized away; the check digit is validated before Cronometer opens.");
const diaryMealInputSchema = z.enum(FOOD_LOG_MEALS)
  .describe("Exact Cronometer diary section. Use Breakfast, Lunch, Dinner, Snacks, or Supplements; do not guess a custom meal label.");
const diaryDateInputSchema = dateValueInputSchema
  .describe("Optional Cronometer diary date as YYYY-MM-DD, today, yesterday, or tomorrow. Defaults to today in the configured timezone.");
const foodTimestampInputSchema = z.string()
  .refine((value) => Boolean(parseFoodLogTimestamp(value)), {
    message: "Use unambiguous 24-hour HH:MM or 12-hour h:mm AM/PM time.",
  })
  .describe("Optional exact food time as 24-hour HH:MM (13:05) or 12-hour h:mm AM/PM (1:05 PM). Ambiguous values such as '1' are rejected.");

export const MCP_PATH = "/mcp";
export const MCP_SERVER_VERSION = "0.1.5";
const readToolSecuritySchemes = [{ type: "oauth2" as const, scopes: ["cronometer:read"] }];
const writeToolSecuritySchemes = [{ type: "oauth2" as const, scopes: ["cronometer:read", "cronometer:write"] }];
export const STABLE_MODEL_VISIBLE_TOOLS = [
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
] as const;
const stableModelVisibleTools = new Set<string>(STABLE_MODEL_VISIBLE_TOOLS);

const MCP_SERVER_INSTRUCTIONS = [
  "Use create_and_log_custom_food as the preferred single-step workflow when a packaged food is missing from Cronometer and the user wants it logged.",
  "Use ensure_private_recipe as the preferred private recipe workflow. Unconfirmed calls preview without opening Cronometer; confirmed calls verify an exact existing name before creating anything.",
  "For custom foods, use Cronometer's detailed #/custom-foods editor: pass the package serving size, every nutrient available on the label, and the UPC/EAN/GTIN barcode whenever it is visible. The barcode links the private custom food to future barcode searches/scans.",
  "Do not call duplicate-list tools before create_custom_food or create_and_log_custom_food; those tools resolve exact same-name foods themselves and default to updating one exact match.",
  "For every diary food write or delete, pass the user's exact meal section explicitly. A write is not attempted unless the requested date, meal, optional time, amount, and unit can be verified before Save.",
  "Use dryRun=true when nutrition facts or barcode data are uncertain. For a confirmed background write, do not retry while it is accepted or running; poll cronometer_runtime_status until completion.",
  "Treat possibly_written_verify_failed as an ambiguous write: inspect the custom-food list or diary before retrying so a duplicate is not created.",
  "Treat ok=false or completed=false as not completed, even when the tool call itself returned normally. accepted means a background job is still pending, not that the requested write succeeded.",
].join("\n");

export function createCronoServer(options: { grantedScopes?: readonly string[] } = {}) {
  const server = new McpServer(
    { name: "cronogpt", version: MCP_SERVER_VERSION },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );

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
    const securitySchemes = annotations.readOnlyHint === true && annotations.destructiveHint !== true
      ? readToolSecuritySchemes
      : writeToolSecuritySchemes;
    const modelVisible = process.env.CRONOGPT_FULL_TOOL_SURFACE === "true" || stableModelVisibleTools.has(name);
    const baseToolConfig = {
      title,
      description,
      inputSchema,
      outputSchema: commonOutputSchema,
      securitySchemes,
      annotations,
      _meta: {
        securitySchemes,
        ui: { visibility: ["model"] },
        "openai/toolInvocation/invoking": "Running Cronometer tool...",
        "openai/toolInvocation/invoked": "Cronometer tool complete.",
      },
    };

    const toolHandler = async (args: unknown) => {
      if (securitySchemes === writeToolSecuritySchemes && options.grantedScopes && !options.grantedScopes.includes("cronometer:write")) {
        return toMcpToolResponse({
          provider: provider.name,
          mode: provider.mode,
          feature: name,
          status: "error",
          warning: "This OAuth access token does not include the required cronometer:write scope. Relink cronogpt with write access before calling this tool.",
          source: "oauth-scope-enforcement",
        });
      }
      return handler((args ?? {}) as Record<string, unknown>);
    };
    if (modelVisible) {
      server.registerTool(name, baseToolConfig, toolHandler);
      return;
    }

    registerAppTool(
      server,
      name,
      {
        ...baseToolConfig,
        _meta: {
          ...baseToolConfig._meta,
          ui: { resourceUri: widgetUri, visibility: ["app"] },
          "openai/outputTemplate": widgetUri,
          "openai/widgetAccessible": true,
        },
      } as Parameters<typeof registerAppTool>[2],
      toolHandler,
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

  const sanitizedRecipeListResult = (feature: string, result: Awaited<ReturnType<typeof provider.listCustomRecipes>>) => {
    const data = (result.data ?? {}) as {
      query?: unknown;
      count?: unknown;
      names?: unknown;
      recipes?: unknown;
      duplicateGroups?: unknown;
    };
    const recipes = Array.isArray(data.recipes)
      ? data.recipes.map((recipe) => sanitizeRecipeSummary(recipe))
      : undefined;
    return {
      ...result,
      feature,
      data: {
        query: data.query,
        count: data.count,
        names: Array.isArray(data.names) ? data.names.filter((name): name is string => typeof name === "string") : [],
        recipes,
        duplicateGroups: data.duplicateGroups,
      },
    };
  };

  const sanitizeRecipeSummary = (recipe: unknown) => {
    const value = recipe && typeof recipe === "object" ? recipe as Record<string, unknown> : {};
    return {
      name: typeof value.name === "string" ? value.name : undefined,
      recipeId: typeof value.recipeId === "string" ? value.recipeId : undefined,
      servings: typeof value.servings === "number" ? value.servings : undefined,
      servingName: typeof value.servingName === "string" ? value.servingName : undefined,
      ingredients: Array.isArray(value.ingredients)
        ? value.ingredients.map((ingredient) => {
          const item = ingredient && typeof ingredient === "object" ? ingredient as Record<string, unknown> : {};
          return {
            name: typeof item.name === "string" ? item.name : undefined,
            amount: typeof item.amount === "number" || typeof item.amount === "string" ? item.amount : undefined,
            unit: typeof item.unit === "string" ? item.unit : undefined,
            source: typeof item.source === "string" ? item.source : undefined,
          };
        })
        : undefined,
    };
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
    register(name, title, description, inputSchema, { readOnlyHint: true, openWorldHint: false }, async (args) =>
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
        writeFormat: "create_custom_food.nutrients accepts any schema key, any listed alias, or an exact Cronometer display label as a numeric value in the label's Cronometer unit. For Israeli-style labels where carbohydrates are listed excluding fiber/polyols, pass that value as total_carbs or net_carbs; cronogpt maps it to Cronometer's Total Carbs field and records fiber/sugar_alcohol separately when provided.",
      },
    }),
  );

  register(
    "refresh_cronometer_session",
    "Refresh Cronometer browser session",
    "Opens Cronometer once to verify login and warm the hosted browser storage cache. Does not write diary data.",
    emptyInputSchema,
    { readOnlyHint: true, openWorldHint: false },
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
    { readOnlyHint: true, openWorldHint: false },
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
    { readOnlyHint: true, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.runUiFlow(args as never)),
  );

  register(
    "get_daily_summary",
    "Get daily nutrition summary",
    "Reads a Cronometer daily nutrition summary for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.getDailySummary(args)),
  );

  register(
    "list_food_entries",
    "List food entries",
    "Lists Cronometer food and recipe diary entries for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.listFoodEntries(args)),
  );

  register(
    "list_biometrics",
    "List biometrics",
    "Lists Cronometer biometric entries for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.listBiometrics(args)),
  );

  register(
    "list_exercises",
    "List exercises",
    "Lists Cronometer exercise entries for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.listExercises(args)),
  );

  register(
    "list_notes",
    "List notes",
    "Lists Cronometer diary notes for a date or date range.",
    dateRangeInputSchema,
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.listNotes(args)),
  );

  register(
    "search_foods",
    "Search foods",
    "Searches the bounded Cronometer food database and the authenticated user's private Cronometer foods for visible food matches. Use searchScope=custom for private custom foods/recipes, all for official database lookups, or auto by default. It does not browse arbitrary websites or access files.",
    {
      query: z.string().min(1),
      limit: z.number().int().positive().max(25).optional(),
      searchScope: z.enum(["auto", "all", "custom", "favorites"]).optional(),
      selectedSource: z.string().optional().describe("Optional source preference such as CRDB, NCCDB, USDA, Custom Food, Custom Recipe, or Brand."),
    },
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.searchFoods({
      query: String(args.query),
      limit: args.limit as number | undefined,
      searchScope: args.searchScope as "auto" | "all" | "custom" | "favorites" | undefined,
      selectedSource: args.selectedSource as string | undefined,
    })),
  );

  register(
    "resolve_recipe_ingredients",
    "Resolve recipe ingredients",
    "Optionally searches the bounded Cronometer food database for each recipe ingredient when the user wants to review exact food/source choices before ensuring a private custom Cronometer recipe. For a small straightforward recipe, ensure_private_recipe can be called directly with ingredient query, amount, unit, confirmed=true, and dryRun=false.",
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
      ).min(1),
      limitPerIngredient: z.number().int().positive().max(5).optional(),
      maxSeconds: z.number().int().positive().max(900).optional(),
    },
    { readOnlyHint: true, openWorldHint: false },
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
    "Adds one food to an explicit Cronometer meal. The server verifies the diary date plus the requested meal, optional time, amount, and unit before Save, then verifies the exact structured diary row afterward. Confirmed real writes are idempotent background jobs. accepted is not success: poll cronometer_runtime_status before any retry. Use selectedName/selectedSource from search_foods for exact choices, especially private custom foods.",
    {
      date: diaryDateInputSchema.optional(),
      meal: diaryMealInputSchema,
      query: z.string().min(1),
      selectedName: z.string().optional(),
      selectedSource: z.string().optional().describe("Optional Cronometer result source from search_foods, such as CRDB, NCCDB, USDA, Custom Food, Custom Recipe, or Brand."),
      amount: z.number().positive().optional(),
      unit: z.string().min(1).optional(),
      timestamp: foodTimestampInputSchema.optional(),
      matchPolicy: z.enum(["high_confidence", "selected_only"]).optional().describe("Defaults to high_confidence. Use selected_only with selectedName and selectedSource to pin an exact search result. Unsafe best-effort writes are intentionally not model-visible."),
      searchScope: z.enum(["auto", "all", "custom", "favorites"]).optional().describe("Optional food-search tab preference. Use custom for private custom foods/recipes, all for official database lookups, or auto by default."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      idempotencyKey: z.string().optional().describe("Optional caller-supplied idempotency key. If omitted, cronogpt derives one from date, meal, food, amount, and unit."),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a short server-chosen wait window. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.logFood(args as never)),
  );

  register(
    "log_foods",
    "Log multiple foods",
    "Adds multiple distinct foods to one explicit Cronometer diary meal as one idempotent batch. Date and meal are batch-level so items cannot drift into different sections. Semantically duplicate items are rejected before the browser opens instead of being silently collapsed. The server logs sequentially, verifies every row, and reports per-item status.",
    {
      date: diaryDateInputSchema.optional(),
      meal: diaryMealInputSchema,
      items: z.array(z.object({
        query: z.string().min(1),
        selectedName: z.string().optional(),
        selectedSource: z.string().optional().describe("Optional Cronometer result source from search_foods, such as CRDB, NCCDB, USDA, Custom Food, Custom Recipe, or Brand."),
        amount: z.number().positive().optional(),
        unit: z.string().min(1).optional(),
        timestamp: foodTimestampInputSchema.optional(),
        matchPolicy: z.enum(["high_confidence", "selected_only"]).optional().describe("Defaults to high_confidence. Use selected_only with selectedName and selectedSource to pin an exact search result."),
        searchScope: z.enum(["auto", "all", "custom", "favorites"]).optional().describe("Optional food-search tab preference. Use custom for private custom foods/recipes, all for official database lookups, or auto by default."),
        idempotencyKey: z.string().optional().describe("Optional per-item idempotency key. If omitted, cronogpt derives one from date, meal, food, amount, and unit."),
      })).min(1).max(50),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      idempotencyKey: z.string().optional().describe("Optional caller-supplied batch idempotency key. If omitted, cronogpt derives one from all normalized item keys."),
      stopOnFirstFailure: z.boolean().optional().describe("Set true to stop attempting later items after the first unresolved result. Already verified earlier writes cannot be rolled back."),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for batch writes. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.logFoods(args as never)),
  );

  register(
    "delete_diary_food_entry",
    "Delete diary food entry",
    "Deletes one matching food entry from a Cronometer diary meal. Requires dryRun=false, confirmed=true, and confirmName exactly matching the food name. Refuses broad or multi-match deletes.",
    {
      date: diaryDateInputSchema.optional(),
      meal: diaryMealInputSchema,
      name: z.string().min(1).describe("Exact visible diary food name to delete."),
      amount: z.number().positive().optional().describe("Optional amount used to narrow the matching diary row."),
      unit: z.string().min(1).optional().describe("Optional unit used to narrow the matching diary row."),
      confirmName: z.string().optional().describe("Must exactly match name when executing the delete."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed deletes. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.deleteDiaryFoodEntry(args as never)),
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.logNote(args as never)),
  );

  register(
    "create_custom_food",
    "Create detailed barcode-linked custom food",
    "Use this when the user wants a private Cronometer custom food created or safely updated without immediately logging it. This is the preferred custom-food path: use the package serving size, include every nutrient available from the label, and pass the UPC/EAN/GTIN barcode whenever visible so later barcode searches/scans resolve to this food. It handles same-name duplicates internally; do not call list_custom_foods first. For Israeli labels, pass listed available carbohydrates as total_carbs or net_carbs and pass fiber/sugar_alcohol separately.",
    {
      name: z.string().min(1),
      servingSize: z.string().min(1).describe("Required explicit serving size, for example '100 g', '1 serving', '250 ml', or '1 oz'."),
      nutrients: nonEmptyNutrientRecordSchema.describe("Required nutrition facts using custom_food_nutrient_schema keys, aliases, or exact Cronometer labels. Include every value present on the package label, including caffeine, vitamins, minerals, amino acids, or fatty acids when available."),
      barcode: barcodeInputSchema.optional(),
      duplicatePolicy: z.enum(["fail", "update_existing", "create_new"]).optional().describe("Defaults to update_existing for exactly one same-named food, fails on multiple matches, and creates only when no match exists. Use create_new only when a duplicate is intentional."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed writes. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.createCustomFood(args as never)),
  );

  register(
    "create_and_log_custom_food",
    "Create and log detailed barcode-linked custom food",
    "Use this as the preferred one-call workflow when a packaged food is missing from Cronometer and the user wants to log it now. Supply the package serving size, every available label nutrient, the UPC/EAN/GTIN barcode whenever visible, and the user's exact diary meal. The tool validates the detailed editor, handles same-name foods internally, verifies the saved barcode and nutrients, then pins and logs that exact private custom food. Do not call list_custom_foods first. Use dryRun=true when facts are uncertain; confirmed=true is required for writes.",
    {
      name: z.string().min(1).describe("Exact custom food name to create/update and then log."),
      servingSize: z.string().min(1).describe("Required serving size for the custom food, for example '100 g', '1 serving', '250 ml', or '1 oz'."),
      nutrients: nonEmptyNutrientRecordSchema.describe("Required package-label values using custom_food_nutrient_schema keys, aliases, or exact Cronometer labels. Include every available value, not only calories and macros."),
      nutritionSource: z.string().optional().describe("Short citation or URL/title summary of where ChatGPT found the nutrition facts. Stored in the tool result for audit; not written as a secret."),
      barcode: barcodeInputSchema.optional(),
      duplicatePolicy: z.enum(["fail", "update_existing"]).optional().describe("Defaults to update_existing so an existing same-named custom food is updated rather than duplicated. Use create_custom_food separately only when an intentional duplicate is required."),
      date: diaryDateInputSchema.optional(),
      meal: diaryMealInputSchema,
      amount: z.number().positive().optional().describe("Amount to log in the diary. Defaults to 1."),
      unit: z.string().min(1).optional().describe("Diary unit to log. Omit to use Cronometer's default serving if appropriate."),
      timestamp: foodTimestampInputSchema.optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed create-and-log writes. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.createAndLogCustomFood(args as never)),
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
    { readOnlyHint: true, openWorldHint: false },
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
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.findDuplicateCustomFoods(args as never)),
  );

  register(
    "update_custom_food",
    "Update detailed barcode-linked custom food",
    "Use this when one existing Cronometer custom food must be edited by its exact current name; include foodId to disambiguate duplicate names. It can add a verified package barcode and update detailed nutrients, and it never creates a new food.",
    {
      foodId: z.string().optional(),
      name: z.string().min(1).describe("Current exact custom food name. If multiple foods match, also pass foodId from list_custom_foods."),
      newName: z.string().optional(),
      servingSize: z.string().optional(),
      nutrients: nutrientRecordSchema.optional().describe("Replacement values for only the provided detailed nutrient fields; omitted fields are left unchanged."),
      barcode: barcodeInputSchema.optional().describe("Barcode to add if it is not already linked to this custom food."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed updates. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.updateCustomFood(args as never)),
  );

  register(
    "delete_custom_food",
    "Delete custom food",
    "Deletes one existing Cronometer custom food by exact name; include foodId to disambiguate duplicate names. Requires confirmed=true and confirmName matching the selected food name.",
    {
      foodId: z.string().optional(),
      name: z.string().min(1).describe("Exact current custom food name. If duplicate names exist, also pass foodId from list_custom_foods."),
      confirmName: z.string().optional(),
      ifUsed: z.enum(["stop", "retire", "force"]).optional().describe("Defaults to stop. Use retire to rename instead if Cronometer warns that old diary entries use this food; use force only after explicit user approval."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed deletes. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.deleteCustomFood(args as never)),
  );

  register(
    "retire_custom_food",
    "Retire custom food",
    "Renames one existing Cronometer custom food instead of deleting it. Pass the exact current name and include foodId to disambiguate duplicates. Use when old diary entries may depend on the food.",
    {
      foodId: z.string().optional(),
      name: z.string().min(1).describe("Exact current custom food name. If duplicate names exist, also pass foodId from list_custom_foods."),
      retiredName: z.string().optional().describe("Optional exact replacement name. Defaults to 'Retired - <name> - YYYY-MM-DD'."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed retire writes. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    "list_private_recipe_names",
    "List private recipe names",
    "Reads only the authenticated user's private Cronometer custom recipe names. Returns names and duplicate groups only, without raw page text or recipe nutrition details.",
    {
      query: z.string().optional().describe("Optional recipe-name filter. Omit this field to list all visible private custom recipe names."),
    },
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(
      sanitizedRecipeListResult(
        "list_private_recipe_names",
        await provider.listCustomRecipes({ query: args.query as string | undefined, includeDetails: false, maxDetails: 0 }),
      ),
    ),
  );

  register(
    "find_private_recipe",
    "Find private recipe",
    "Reads one authenticated user's private Cronometer custom recipe by exact or near-exact name filter and returns a sanitized summary for verification.",
    {
      name: z.string().min(1).describe("Exact private custom recipe name to verify."),
    },
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(
      sanitizedRecipeListResult(
        "find_private_recipe",
        await provider.listCustomRecipes({ query: String(args.name), includeDetails: true, maxDetails: 1 }),
      ),
    ),
  );

  register(
    "list_custom_recipes",
    "List custom recipes",
    "Reads only the authenticated user's private Cronometer Foods > Custom Recipes list, returning structured visible recipe names, optional details, and duplicate groups. It does not browse arbitrary websites or access files.",
    {
      query: z.string().optional().describe("Optional recipe-name filter. Omit this field to list all visible custom recipes."),
      includeDetails: z.boolean().optional(),
      maxDetails: z.number().int().nonnegative().max(25).optional(),
    },
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.listCustomRecipes(args as never)),
  );

  register(
    "create_recipe",
    "Create recipe",
    "Creates and verifies a private custom Cronometer recipe in the authenticated user's account after user confirmation. This does not publish, send, share, or write outside that private Cronometer account. For straightforward ingredients, pass query, amount, and unit directly; the browser provider auto-selects high-confidence official Cronometer matches. Use selectedName and selectedSource only when the user or resolve_recipe_ingredients picked a specific match. Ambiguous low-confidence searches are returned without writing.",
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
      ).min(1),
      servings: z.number().positive().optional(),
      servingName: z.string().optional(),
      cookedWeight: z.number().positive().optional().describe("Optional total cooked/final recipe weight."),
      cookedWeightUnit: z.string().optional().describe("Unit for cookedWeight, such as g or oz."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.createRecipe(args as never)),
  );

  register(
    "ensure_private_recipe",
    "Ensure private recipe",
    "Preferred recipe-writing workflow. Idempotently ensures one private custom Cronometer recipe exists in the authenticated user's account. If an exact recipe name already exists, it returns that private recipe summary without writing; otherwise it creates and verifies the private recipe after user confirmation. Dry-run or unconfirmed calls return a browser-free creation preview. It does not publish, send, share, or write outside that private Cronometer account.",
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
      ).min(1),
      servings: z.number().positive().optional(),
      servingName: z.string().optional(),
      cookedWeight: z.number().positive().optional().describe("Optional total cooked/final recipe weight."),
      cookedWeightUnit: z.string().optional().describe("Unit for cookedWeight, such as g or oz."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      if (args.dryRun === true || args.confirmed !== true) {
        const preview = await provider.createRecipe({
          ...args,
          dryRun: true,
          confirmed: false,
        } as never);
        return toMcpToolResponse({
          ...preview,
          feature: "ensure_private_recipe",
          data: {
            ...(preview.data && typeof preview.data === "object" ? preview.data as Record<string, unknown> : {}),
            stage: "preview",
            existed: false,
            created: false,
            browserOpened: false,
            writeAttempted: false,
          },
        });
      }

      const name = String(args.name);
      const existing = await provider.listCustomRecipes({ query: name, includeDetails: false, maxDetails: 0 });
      const existingData = (existing.data ?? {}) as { names?: unknown; recipes?: unknown };
      if (existing.status !== "ok") {
        return toMcpToolResponse({
          ...existing,
          feature: "ensure_private_recipe",
          warning: existing.warning ?? "Could not verify the existing private recipe names, so no recipe creation was attempted.",
          data: {
            ...(existing.data && typeof existing.data === "object" ? existing.data as Record<string, unknown> : {}),
            stage: "lookup",
            existed: undefined,
            created: false,
          },
        });
      }

      const exactRecipeFromSummaries = Array.isArray(existingData.recipes)
        ? existingData.recipes.find((recipe) => {
          const value = recipe && typeof recipe === "object" ? recipe as Record<string, unknown> : {};
          return typeof value.name === "string" && value.name.trim().toLowerCase() === name.trim().toLowerCase();
        })
        : undefined;
      const exactName = Array.isArray(existingData.names)
        ? existingData.names.find((candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim().toLowerCase() === name.trim().toLowerCase())
        : undefined;
      const exactRecipe = exactRecipeFromSummaries ?? (exactName ? { name: exactName } : undefined);

      if (exactRecipe) {
        return toMcpToolResponse({
          provider: existing.provider,
          mode: existing.mode,
          feature: "ensure_private_recipe",
          status: "already_exists",
          data: {
            existed: true,
            created: false,
            recipe: sanitizeRecipeSummary(exactRecipe),
          },
        });
      }

      const created = await provider.createRecipe(args as never);
      return toMcpToolResponse({
        ...created,
        feature: "ensure_private_recipe",
        data: {
          ...(created.data && typeof created.data === "object" ? created.data as Record<string, unknown> : {}),
          existed: false,
          created: ["ok", "written", "already_exists"].includes(created.status),
        },
      });
    },
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
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
      ).min(1).optional(),
      servings: z.number().positive().optional(),
      servingName: z.string().optional(),
      cookedWeight: z.number().positive().optional(),
      cookedWeightUnit: z.string().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.retireCustomRecipe(args as never)),
  );

  register(
    "get_targets",
    "Get targets",
    "Reads the authenticated account's current Cronometer calorie, macro, and nutrient target settings. Targets are profile settings, not diary-date-specific.",
    emptyInputSchema,
    { readOnlyHint: true, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: true, openWorldHint: false },
    "Ask the Oracle exists in the live UI; selectors and account-tier behavior still need verification.",
  );

  registerFrameworkTool(
    "suggest_food",
    "Suggest food",
    "Submits a Cronometer food suggestion after confirmation.",
    { name: z.string().min(1), notes: z.string().optional(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
        publicOrigin: process.env.APP_PUBLIC_ORIGIN,
        appVersion: MCP_SERVER_VERSION,
        gitCommit: process.env.CRONOGPT_GIT_COMMIT,
        buildTimestamp: process.env.CRONOGPT_BUILD_TIMESTAMP,
        stableToolSurface: process.env.CRONOGPT_FULL_TOOL_SURFACE !== "true",
        stableModelVisibleTools: STABLE_MODEL_VISIBLE_TOOLS,
        stableModelVisibleToolCount: STABLE_MODEL_VISIBLE_TOOLS.length,
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

    const server = createCronoServer({ grantedScopes: auth.scopes });
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
