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
import { customFoodTransactionPreview } from "./domain.js";
import type {
  CronometerProvider,
  DiaryFoodDeleteInput,
  FoodLogInput,
  ProviderResult,
  ProviderStatus,
  RecipeInput,
} from "./domain.js";
import { comparePrivateRecipe, type ExistingRecipeSummary } from "./recipe-semantics.js";
import {
  authorizeMcpRequest,
  getAuthToken,
  handleOAuthRequest,
  rejectUnauthorized,
} from "./oauth.js";
import { applyCorsResponseHeaders, validateRequestAuthority } from "./http-security.js";

const widgetHtml = readFileSync(join(process.cwd(), "public/cronometer-widget.html"), "utf8");
const widgetUri = "ui://widget/cronometer-dashboard.html";
export const MAX_MCP_REQUEST_BODY_BYTES = 256 * 1024;
export const MAX_CONCURRENT_MCP_REQUESTS = 16;
let activeMcpRequests = 0;

const defaultProvider = createProviderFromEnv();

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
  state: z.enum(["pending", "running", "succeeded", "failed", "indeterminate"]).optional(),
  retryable: z.boolean().optional(),
  nextAction: z.enum(["none", "poll", "inspect_diary", "retry_with_same_key", "manual_resolution"]).optional(),
  operationId: z.string().optional(),
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
const foodPortionDefinitionSchema = z.object({
  name: z.string().min(1).describe("Exact portion name, for example bag, piece, can, or serving."),
  weightGrams: z.number().finite().positive().describe("Weight in grams of one named portion."),
});
const customFoodPortionsSchema = z.array(foodPortionDefinitionSchema)
  .min(1)
  .superRefine((portions, context) => {
    const names = new Set<string>();
    portions.forEach((portion, index) => {
      const normalizedName = portion.name.replace(/\s+/g, " ").trim().toLowerCase();
      if (names.has(normalizedName)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "name"], message: "Each custom-food portion name must be unique." });
      }
      names.add(normalizedName);
    });
  })
  .describe("Optional additional exact portion name-to-gram mappings, such as piece=10 g, serving=30 g, or bag=130 g. When present without servingSize, CronoGPT uses a stable base servingSize of 1 g.");
const expectedExistingMatchCountSchema = z.number().int().nonnegative()
  .describe("Optional exact match count from an immediately preceding read-only lookup. The write refuses a changed count instead of overwriting a concurrent change.");
const wholePackagePortionSchema = z.object({
  kind: z.literal("whole_package"),
  portion: foodPortionDefinitionSchema.describe("The package portion as its exact name-to-weight mapping."),
  count: z.number().finite().positive().optional().describe("Number of whole packages consumed. Defaults to 1."),
}).describe("Use when the user consumed a whole package. CronoGPT logs count × portion.weightGrams, so multiple portions on the same food remain unambiguous.");

export const MCP_PATH = "/mcp";
export const MCP_SERVER_VERSION = "0.1.18";
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
  "log_food_plan",
  "delete_diary_food_entry",
  "delete_diary_food_entries",
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
  "list_custom_recipes",
  "resolve_recipe_ingredients",
  "ensure_private_recipe",
  "create_recipe",
  "update_custom_recipe",
  "delete_custom_recipe",
  "retire_custom_recipe",
  "cronometer_runtime_status",
  "get_cronometer_operation",
  "cronometer_stability_check",
  "refresh_cronometer_session",
] as const;
const stableModelVisibleTools = new Set<string>(STABLE_MODEL_VISIBLE_TOOLS);

const MCP_SERVER_INSTRUCTIONS = [
  "Use create_and_log_custom_food as the preferred single-step workflow when a packaged food is missing from Cronometer and the user wants it logged.",
  "Use ensure_private_recipe as the preferred private recipe workflow. Unconfirmed calls preview without opening Cronometer; confirmed calls compare full recipe contents and safely repair an incomplete same-named recipe when possible. Use create_recipe directly only after find_private_recipe has confirmed that the exact recipe name is absent. Use delete_custom_recipe only with an exact recipe ID and confirmation name for user-approved cleanup or rollback; it retires instead of deleting when Cronometer reports existing uses unless the user explicitly requests force.",
  "For custom foods, use Cronometer's detailed #/custom-foods editor: pass the package serving size, every nutrient available on the label, and the UPC/EAN/GTIN barcode whenever it is visible. The barcode links the private custom food to future barcode searches/scans.",
  "Do not call duplicate-list tools before create_custom_food or create_and_log_custom_food; those tools resolve exact same-name foods themselves and default to updating one exact match.",
  "For every diary food write or delete, pass the user's exact meal section explicitly. A product or search category never chooses the meal: if the user says Lunch, pass Lunch even for an energy drink or supplement-like product.",
  "For a whole bag, can, bottle, or package, pass portion={kind:'whole_package',portion:{name,weightGrams},count}. A custom food can have multiple named portions; use the exact name-to-weight mapping for the consumed package and never guess its weight. Do not also pass amount/unit.",
  "Submit one multi-food user intent once through log_foods. For a confirmed background write, accepted means the write is in progress, not failed: never resubmit it; poll get_cronometer_operation with the returned operation ID.",
  "Use log_food_plan for one bounded intent that spans multiple dates or meal sections, and delete_diary_food_entries for a bounded exact multi-day cleanup. These tools stop before later groups after an unresolved or ambiguous result; inspect their per-group or per-item results instead of blindly retrying the whole plan.",
  "Treat possibly_written_verify_failed as an ambiguous write: inspect the custom-food list or diary before retrying so a duplicate is not created.",
  "Treat ok=false or completed=false as not completed, even when the tool call itself returned normally. accepted means a background job is still pending, not that the requested write succeeded.",
].join("\n");

export function createCronoServer(options: { grantedScopes?: readonly string[]; provider?: CronometerProvider } = {}) {
  const provider = options.provider ?? defaultProvider;
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
      cookedWeight: typeof value.cookedWeight === "number" ? value.cookedWeight : undefined,
      cookedWeightUnit: typeof value.cookedWeightUnit === "string" ? value.cookedWeightUnit : undefined,
      ingredientsStatus: value.ingredientsStatus === "parsed" || value.ingredientsStatus === "empty_confirmed" || value.ingredientsStatus === "extraction_failed"
        ? value.ingredientsStatus
        : undefined,
      ingredients: Array.isArray(value.ingredients)
        ? value.ingredients.map((ingredient) => {
          const item = ingredient && typeof ingredient === "object" ? ingredient as Record<string, unknown> : {};
          return {
            name: typeof item.name === "string" ? item.name : undefined,
            amount: typeof item.amount === "number" || typeof item.amount === "string" ? item.amount : undefined,
            unit: typeof item.unit === "string" ? item.unit : undefined,
            source: typeof item.source === "string"
              ? item.source
              : typeof item.database === "string" ? item.database : undefined,
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
    "get_cronometer_operation",
    "Get Cronometer operation",
    "Polls one accepted Cronometer background operation by its returned operation ID. Use this instead of resubmitting a write.",
    { operationId: z.string().min(1) },
    { readOnlyHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.getOperation(String(args.operationId))),
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
      portion: wholePackagePortionSchema.optional(),
      timestamp: foodTimestampInputSchema.optional(),
      matchPolicy: z.enum(["high_confidence", "selected_only"]).optional().describe("Defaults to high_confidence. Use selected_only with selectedName and selectedSource to pin an exact search result. Unsafe best-effort writes are intentionally not model-visible."),
      searchScope: z.enum(["auto", "all", "custom", "favorites"]).optional().describe("Optional food-search tab preference. Use custom for private custom foods/recipes, all for official database lookups, or auto by default."),
      expectedExistingMatchCount: expectedExistingMatchCountSchema.optional(),
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
        portion: wholePackagePortionSchema.optional(),
        timestamp: foodTimestampInputSchema.optional(),
        matchPolicy: z.enum(["high_confidence", "selected_only"]).optional().describe("Defaults to high_confidence. Use selected_only with selectedName and selectedSource to pin an exact search result."),
        searchScope: z.enum(["auto", "all", "custom", "favorites"]).optional().describe("Optional food-search tab preference. Use custom for private custom foods/recipes, all for official database lookups, or auto by default."),
        expectedExistingMatchCount: expectedExistingMatchCountSchema.optional(),
        idempotencyKey: z.string().optional().describe("Optional per-item idempotency key. If omitted, cronogpt derives one from date, meal, food, amount, and unit."),
      })).min(1).max(50),
      expectedExistingMatchCount: z.array(expectedExistingMatchCountSchema).optional().describe("Optional expected exact-row counts in items order from a prior lookup. Each supplied value must match its corresponding item's current count before write."),
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
    "log_food_plan",
    "Log a multi-day food plan",
    "Adds a bounded set of foods across multiple explicit Cronometer dates and meal sections. The server groups items by date and meal, submits each group through the verified idempotent log_foods transaction, and stops before later groups after any accepted, ambiguous, or failed result. Use this for one user intent that cannot fit in a single meal batch.",
    {
      items: z.array(z.object({
        date: diaryDateInputSchema,
        meal: diaryMealInputSchema,
        query: z.string().min(1),
        selectedName: z.string().optional(),
        selectedSource: z.string().optional().describe("Optional exact Cronometer source from search_foods, such as CRDB, NCCDB, Custom Food, or Custom Recipe."),
        amount: z.number().positive().optional(),
        unit: z.string().min(1).optional(),
        portion: wholePackagePortionSchema.optional(),
        timestamp: foodTimestampInputSchema.optional(),
        matchPolicy: z.enum(["high_confidence", "selected_only"]).optional(),
        searchScope: z.enum(["auto", "all", "custom", "favorites"]).optional(),
        expectedExistingMatchCount: expectedExistingMatchCountSchema.optional(),
        idempotencyKey: z.string().optional(),
      })).min(1).max(100),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      idempotencyKey: z.string().optional().describe("Optional plan-level idempotency key. CronoGPT derives deterministic group and item keys from it."),
      stopOnFirstFailure: z.boolean().optional().describe("Defaults to true across date/meal groups. Later groups are never started after an accepted, ambiguous, or failed result."),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await runFoodLogPlan(provider, args)),
  );

  register(
    "delete_diary_food_entry",
    "Delete diary food entry",
    "Deletes a bounded number of matching food entries from one explicit Cronometer diary meal. By default it preserves the conservative unique-match behavior. For indistinguishable duplicate rows, first preview the match count, then pass an explicit deleteCount with confirmation; the server deletes one at a time and verifies the count drops by exactly one after each action.",
    {
      date: diaryDateInputSchema.optional(),
      meal: diaryMealInputSchema,
      name: z.string().min(1).describe("Exact visible diary food name to delete."),
      amount: z.number().positive().optional().describe("Optional amount used to narrow the matching diary row."),
      unit: z.string().min(1).optional().describe("Optional unit used to narrow the matching diary row."),
      deleteCount: z.number().int().positive().optional().describe("Exact number of indistinguishable matching rows to delete. Omit for the conservative unique-match default; there is intentionally no delete-all mode."),
      confirmName: z.string().optional().describe("Must exactly match name when executing the delete."),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed deletes. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await provider.deleteDiaryFoodEntry(args as never)),
  );

  register(
    "delete_diary_food_entries",
    "Delete exact diary food entries across days",
    "Deletes a bounded explicit list of diary rows across multiple dates and meal sections. Every item requires its exact visible name and matching confirmation name. The server invokes the conservative verified single-entry delete sequentially and stops before later items after any accepted, ambiguous, or failed result; there is no delete-all mode.",
    {
      items: z.array(z.object({
        date: diaryDateInputSchema,
        meal: diaryMealInputSchema,
        name: z.string().min(1),
        amount: z.number().positive().optional(),
        unit: z.string().min(1).optional(),
        deleteCount: z.number().int().positive().optional(),
        confirmName: z.string().min(1).describe("Must exactly match this item's name."),
      })).min(1).max(100),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      stopOnFirstFailure: z.boolean().optional().describe("Defaults to true. Later deletes are not attempted after an unresolved result."),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (args) => toMcpToolResponse(await runDiaryDeletePlan(provider, args)),
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
      servingSize: z.string().min(1).optional().describe("Primary nutrition-label serving size. When portions is supplied and this is omitted, CronoGPT uses the preferred stable base serving of 1 g; without portions, an explicit servingSize remains required."),
      portions: customFoodPortionsSchema.optional(),
      nutrients: nonEmptyNutrientRecordSchema.describe("Required nutrition facts using custom_food_nutrient_schema keys, aliases, or exact Cronometer labels. Include every value present on the package label, including caffeine, vitamins, minerals, amino acids, or fatty acids when available."),
      barcode: barcodeInputSchema.optional(),
      duplicatePolicy: z.enum(["fail", "update_existing", "create_new"]).optional().describe("Defaults to update_existing for exactly one same-named food, fails on multiple matches, and creates only when no match exists. Use create_new only when a duplicate is intentional."),
      expectedExistingMatchCount: expectedExistingMatchCountSchema.optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed writes. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      const preview = customFoodTransactionPreview({ ...args, requireServingSize: true } as never);
      if (!preview.valid) {
        return toMcpToolResponse({ provider: provider.name, mode: provider.mode, feature: "create_custom_food", status: "needs_manual_step", warning: preview.issues.join(" "), data: { preview, browserOpened: false, writeAttempted: false } });
      }
      return toMcpToolResponse(await provider.createCustomFood({ ...args, servingSize: preview.servingSize } as never));
    },
  );

  register(
    "create_and_log_custom_food",
    "Create and log detailed barcode-linked custom food",
    "Use this as the preferred one-call workflow when a packaged food is missing from Cronometer and the user wants to log it now. Supply the package serving size, every available label nutrient, the UPC/EAN/GTIN barcode whenever visible, and the user's exact diary meal. The tool validates the detailed editor, handles same-name foods internally, verifies the saved barcode and nutrients, then pins and logs that exact private custom food. Do not call list_custom_foods first. Use dryRun=true when facts are uncertain; confirmed=true is required for writes.",
    {
      name: z.string().min(1).describe("Exact custom food name to create/update and then log."),
      servingSize: z.string().min(1).optional().describe("Primary nutrition-label serving size. When portions is supplied and this is omitted, CronoGPT uses the preferred stable base serving of 1 g; without portions, an explicit servingSize remains required."),
      portions: customFoodPortionsSchema.optional(),
      nutrients: nonEmptyNutrientRecordSchema.describe("Required package-label values using custom_food_nutrient_schema keys, aliases, or exact Cronometer labels. Include every available value, not only calories and macros."),
      nutritionSource: z.string().optional().describe("Short citation or URL/title summary of where ChatGPT found the nutrition facts. Stored in the tool result for audit; not written as a secret."),
      barcode: barcodeInputSchema.optional(),
      duplicatePolicy: z.enum(["fail", "update_existing"]).optional().describe("Defaults to update_existing so an existing same-named custom food is updated rather than duplicated. Use create_custom_food separately only when an intentional duplicate is required."),
      expectedExistingMatchCount: expectedExistingMatchCountSchema.optional(),
      date: diaryDateInputSchema.optional(),
      meal: diaryMealInputSchema,
      amount: z.number().positive().optional().describe("Amount to log in the diary. Defaults to 1 only when portion is omitted."),
      unit: z.string().min(1).optional().describe("Diary unit to log. Omit when using portion."),
      portion: wholePackagePortionSchema.optional(),
      timestamp: foodTimestampInputSchema.optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed create-and-log writes. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      const preview = customFoodTransactionPreview({ ...args, requireServingSize: true } as never);
      if (!preview.valid) {
        return toMcpToolResponse({ provider: provider.name, mode: provider.mode, feature: "create_and_log_custom_food", status: "needs_manual_step", warning: preview.issues.join(" "), data: { preview, browserOpened: false, writeAttempted: false } });
      }
      return toMcpToolResponse(await provider.createAndLogCustomFood({ ...args, servingSize: preview.servingSize } as never));
    },
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
      portions: customFoodPortionsSchema.optional(),
      nutrients: nutrientRecordSchema.optional().describe("Replacement values for only the provided detailed nutrient fields; omitted fields are left unchanged."),
      barcode: barcodeInputSchema.optional().describe("Barcode to add if it is not already linked to this custom food."),
      expectedExistingMatchCount: expectedExistingMatchCountSchema.optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
      waitForCompletionSeconds: z.number().int().min(0).max(600).optional().describe("Defaults to a server-chosen wait window for confirmed updates. Use 0 to return immediately after accepting the background job."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      const preview = customFoodTransactionPreview({ ...args, requireServingSize: true } as never);
      if (!preview.valid) {
        return toMcpToolResponse({ provider: provider.name, mode: provider.mode, feature: "update_custom_food", status: "needs_manual_step", warning: preview.issues.join(" "), data: { preview, browserOpened: false, writeAttempted: false } });
      }
      return toMcpToolResponse(await provider.updateCustomFood({ ...args, servingSize: args.servingSize === undefined ? undefined : preview.servingSize } as never));
    },
  );

  register(
    "delete_custom_food",
    "Delete custom food",
    "Deletes one existing Cronometer custom food by exact name; include foodId to disambiguate duplicate names. Requires confirmed=true and confirmName matching the selected food name.",
    {
      foodId: z.string().optional(),
      name: z.string().min(1).describe("Exact current custom food name. If duplicate names exist, also pass foodId from list_custom_foods."),
      confirmName: z.string().optional(),
      ifUsed: z.enum(["stop", "retire", "force"]).optional().describe("Defaults to stop. Use retire to click Cronometer's native Retire action if old diary entries use this food; use force only after explicit user approval."),
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
    async (args) => toMcpToolResponse(
      sanitizedRecipeListResult(
        "list_custom_recipes",
        await provider.listCustomRecipes(args as never),
      ),
    ),
  );

  register(
    "create_recipe",
    "Create recipe",
    "Creates and verifies a new private custom Cronometer recipe in the authenticated user's account after user confirmation. Use this direct creator only after find_private_recipe has confirmed that the exact name is absent; otherwise prefer ensure_private_recipe to avoid duplicates. This does not publish, send, share, or write outside that private Cronometer account. For straightforward ingredients, pass query, amount, and unit directly; the browser provider auto-selects high-confidence official Cronometer matches. Use selectedName and selectedSource only when the user or resolve_recipe_ingredients picked a specific match. Ambiguous low-confidence searches are returned without writing.",
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
    "Preferred recipe-writing workflow. Idempotently compares the requested private Cronometer recipe with the full contents of any exact same-named recipe. It returns already_exists only for a semantic match, safely adds missing ingredients or repairs serving fields when the existing recipe is an unambiguous subset, and returns a structured conflict for changed, extra, duplicate, or unparseable contents. Otherwise it creates and verifies the recipe after confirmation. Dry-run or unconfirmed calls return a browser-free preview.",
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
      const ensureProvider = provider;
      if (args.dryRun === true || args.confirmed !== true) {
        const preview = await ensureProvider.createRecipe({
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
      const requestedRecipe = args as unknown as RecipeInput;
      const existing = await ensureProvider.listCustomRecipes({ query: name, includeDetails: true, maxDetails: 5 });
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

      const normalizedName = name.trim().toLowerCase();
      const exactNames = Array.isArray(existingData.names)
        ? existingData.names.filter((candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim().toLowerCase() === normalizedName)
        : [];
      const exactRecipes = Array.isArray(existingData.recipes)
        ? existingData.recipes.filter((recipe) => {
          const value = recipe && typeof recipe === "object" ? recipe as Record<string, unknown> : {};
          return typeof value.name === "string" && value.name.trim().toLowerCase() === normalizedName;
        })
        : [];

      if (exactNames.length > 1 || exactRecipes.length > 1) {
        return toMcpToolResponse({
          provider: existing.provider,
          mode: existing.mode,
          feature: "ensure_private_recipe",
          status: "needs_manual_step",
          warning: "Multiple exact same-named private recipes were found. No recipe was created or updated because the target is ambiguous.",
          data: {
            existed: true,
            created: false,
            updated: false,
            stage: "conflict",
            conflict: "duplicate_exact_names",
            exactNameCount: Math.max(exactNames.length, exactRecipes.length),
            recipes: exactRecipes.map((recipe) => sanitizeRecipeSummary(recipe)),
          },
        });
      }

      const exactRecipe = exactRecipes[0] as ExistingRecipeSummary | undefined
        ?? (exactNames[0] ? { name: exactNames[0], ingredientsStatus: "extraction_failed" } : undefined);
      if (exactRecipe) {
        const comparison = comparePrivateRecipe(requestedRecipe, exactRecipe);
        if (comparison.matches) {
          return toMcpToolResponse({
            provider: existing.provider,
            mode: existing.mode,
            feature: "ensure_private_recipe",
            status: "already_exists",
            data: {
              existed: true,
              created: false,
              updated: false,
              stage: "verified_existing",
              recipe: sanitizeRecipeSummary(exactRecipe),
              comparison,
            },
          });
        }

        const ingredientsToAdd = comparison.missingIngredients.length > 0 ? comparison.missingIngredients : undefined;
        const servings = comparison.fieldMismatches.servings ? requestedRecipe.servings : undefined;
        const servingName = comparison.fieldMismatches.servingName ? requestedRecipe.servingName : undefined;
        const cookedWeight = comparison.fieldMismatches.cookedWeight ? requestedRecipe.cookedWeight : undefined;
        const cookedWeightUnit = comparison.fieldMismatches.cookedWeightUnit ? requestedRecipe.cookedWeightUnit : undefined;
        const hasRepair = Boolean(ingredientsToAdd?.length || servings !== undefined || servingName !== undefined || cookedWeight !== undefined || cookedWeightUnit !== undefined);

        if (comparison.repairable && hasRepair) {
          const repaired = await ensureProvider.updateCustomRecipe({
            recipeId: typeof exactRecipe.recipeId === "string" ? exactRecipe.recipeId : undefined,
            name,
            ingredientsToAdd,
            servings,
            servingName,
            cookedWeight,
            cookedWeightUnit,
            dryRun: false,
            confirmed: true,
          });
          const updated = ["ok", "written"].includes(repaired.status);
          return toMcpToolResponse({
            ...repaired,
            feature: "ensure_private_recipe",
            data: {
              ...(repaired.data && typeof repaired.data === "object" ? repaired.data as Record<string, unknown> : {}),
              existed: true,
              created: false,
              updated,
              stage: "repair",
              previousRecipe: sanitizeRecipeSummary(exactRecipe),
              comparison,
            },
          });
        }

        return toMcpToolResponse({
          provider: existing.provider,
          mode: existing.mode,
          feature: "ensure_private_recipe",
          status: "needs_manual_step",
          warning: comparison.ingredientsStatus === "extraction_failed"
            ? "The exact same-named recipe was found, but its ingredient table could not be parsed. No write was attempted."
            : "The exact same-named recipe differs in ways that cannot be repaired by only adding missing ingredients or updating serving fields. No write was attempted.",
          data: {
            existed: true,
            created: false,
            updated: false,
            stage: "conflict",
            conflict: comparison.ingredientsStatus === "extraction_failed" ? "ingredient_extraction_failed" : "semantic_mismatch",
            requested: sanitizeRecipeSummary(requestedRecipe),
            existing: sanitizeRecipeSummary(exactRecipe),
            comparison,
          },
        });
      }

      const created = await ensureProvider.createRecipe(args as never);
      return toMcpToolResponse({
        ...created,
        feature: "ensure_private_recipe",
        data: {
          ...(created.data && typeof created.data === "object" ? created.data as Record<string, unknown> : {}),
          existed: false,
          created: ["ok", "written", "already_exists"].includes(created.status),
          updated: false,
          stage: "create",
        },
      });
    },
  );

  register(
    "delete_custom_recipe",
    "Delete custom recipe",
    "Deletes one existing Cronometer custom recipe by exact recipeId or unique exact name. Requires confirmed=true and confirmName matching the selected recipe name. If Cronometer reports existing diary uses, the default behavior is to click Cronometer's native Retire action and preserve history; force deletion requires explicit user approval.",
    {
      recipeId: z.string().optional(),
      name: z.string().optional(),
      confirmName: z.string().optional(),
      ifUsed: z.enum(["stop", "retire", "force"]).optional().describe("Defaults to retire. When Cronometer reports existing diary uses, retire clicks Cronometer's native Retire action and preserves history; force requires explicit user approval."),
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
    "Uses Cronometer's native Retire action for one existing custom recipe, preserving historical diary usage without adding a 'Retired -' prefix.",
    {
      recipeId: z.string().optional(),
      name: z.string().optional(),
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

type MultiDayFoodPlanItem = FoodLogInput & { date: string; meal: string };

async function runFoodLogPlan(provider: CronometerProvider, args: Record<string, unknown>): Promise<ProviderResult> {
  const items = (args.items ?? []) as MultiDayFoodPlanItem[];
  const planIdempotencyKey = typeof args.idempotencyKey === "string" && args.idempotencyKey.trim()
    ? args.idempotencyKey.trim()
    : deterministicPlanKey("food", items);
  const groups = groupFoodPlanItems(items);
  const groupResults: Array<Record<string, unknown>> = [];
  let attemptedCount = 0;
  let stoppedEarly = false;

  for (const [groupIndex, group] of groups.entries()) {
    const result = await provider.logFoods({
      date: group.date,
      meal: group.meal,
      items: group.items.map(({ date: _date, meal: _meal, ...item }, itemIndex) => ({
        ...item,
        idempotencyKey: item.idempotencyKey ?? `${planIdempotencyKey}:item:${group.itemIndices[itemIndex]}`,
      })),
      dryRun: args.dryRun as boolean | undefined,
      confirmed: args.confirmed as boolean | undefined,
      idempotencyKey: `${planIdempotencyKey}:group:${groupIndex}`,
      stopOnFirstFailure: args.stopOnFirstFailure as boolean | undefined,
      waitForCompletionSeconds: args.waitForCompletionSeconds as number | undefined,
    });
    const data = resultData(result);
    const attemptedInGroup = typeof data.attemptedCount === "number"
      ? Math.min(group.items.length, Math.max(0, Math.trunc(data.attemptedCount)))
      : group.items.length;
    attemptedCount += attemptedInGroup;
    groupResults.push({
      groupIndex,
      date: group.date,
      meal: group.meal,
      itemIndices: group.itemIndices,
      status: result.status,
      warning: result.warning,
      operationId: data.operationId,
      data,
      attemptedItemCount: attemptedInGroup,
    });

    if (mustStopOrchestratedPlan(result.status)
      || (args.stopOnFirstFailure !== false && !successfulFoodPlanStatus(result.status) && result.status !== "dry_run")) {
      stoppedEarly = groupIndex < groups.length - 1;
      break;
    }
  }

  const statuses = groupResults.map((result) => result.status as ProviderStatus);
  const status = aggregateOrchestratedStatus(statuses, groups.length, successfulFoodPlanStatus);
  const acceptedOperationId = status === "accepted"
    ? [...groupResults].reverse().find((result) => result.status === "accepted")?.operationId
    : undefined;
  const previewCompleted = groupResults.length === groups.length && statuses.every((candidate) => candidate === "dry_run");
  const completed = groupResults.length === groups.length && statuses.every(successfulFoodPlanStatus);
  const currentPartialGroup = groupResults.length > 0
    ? groups[groupResults.length - 1]
    : undefined;
  const currentPartialAttempted = groupResults.length > 0
    ? Number(groupResults[groupResults.length - 1]?.attemptedItemCount ?? currentPartialGroup?.items.length ?? 0)
    : 0;
  const remainingItemIndices = [
    ...(currentPartialGroup ? currentPartialGroup.itemIndices.slice(currentPartialAttempted) : []),
    ...groups.slice(groupResults.length).flatMap((group) => group.itemIndices),
  ];
  return {
    provider: provider.name,
    mode: provider.mode,
    feature: "log_food_plan",
    status,
    source: "mcp-multi-day-orchestrator",
    warning: completed || previewCompleted
      ? undefined
      : "The multi-day food plan did not fully complete. Inspect group statuses and continue only with untouched or definitively unwritten items; never blindly replay an ambiguous group.",
    data: {
      planIdempotencyKey,
      count: items.length,
      attemptedCount,
      groupCount: groups.length,
      attemptedGroupCount: groupResults.length,
      completed,
      previewCompleted,
      stoppedEarly,
      operationId: acceptedOperationId,
      groups: groupResults,
      remainingItemIndices,
    },
  };
}

async function runDiaryDeletePlan(provider: CronometerProvider, args: Record<string, unknown>): Promise<ProviderResult> {
  const items = (args.items ?? []) as Array<DiaryFoodDeleteInput & { date: string; meal: string; confirmName: string }>;
  const results: Array<Record<string, unknown>> = [];
  let stoppedEarly = false;

  for (const [index, item] of items.entries()) {
    const result = await provider.deleteDiaryFoodEntry({
      ...item,
      dryRun: args.dryRun === undefined && args.confirmed === true ? false : args.dryRun as boolean | undefined,
      confirmed: args.confirmed as boolean | undefined,
      waitForCompletionSeconds: args.waitForCompletionSeconds as number | undefined,
    });
    const data = resultData(result);
    results.push({
      index,
      target: { date: item.date, meal: item.meal, name: item.name, amount: item.amount, unit: item.unit, deleteCount: item.deleteCount ?? 1 },
      status: result.status,
      warning: result.warning,
      operationId: data.operationId,
      data,
    });
    if (mustStopOrchestratedPlan(result.status)
      || (args.stopOnFirstFailure !== false && result.status !== "ok" && result.status !== "dry_run")) {
      stoppedEarly = index < items.length - 1;
      break;
    }
  }

  const statuses = results.map((result) => result.status as ProviderStatus);
  const status = aggregateOrchestratedStatus(statuses, items.length, (candidate) => candidate === "ok");
  const acceptedOperationId = status === "accepted"
    ? [...results].reverse().find((result) => result.status === "accepted")?.operationId
    : undefined;
  const previewCompleted = results.length === items.length && statuses.every((candidate) => candidate === "dry_run");
  const completed = results.length === items.length && statuses.every((candidate) => candidate === "ok");
  return {
    provider: provider.name,
    mode: provider.mode,
    feature: "delete_diary_food_entries",
    status,
    source: "mcp-multi-day-orchestrator",
    warning: completed || previewCompleted
      ? undefined
      : "The exact diary cleanup did not fully complete. Inspect per-item statuses before continuing; ambiguous deletes must be checked with list_food_entries.",
    data: {
      count: items.length,
      attemptedCount: results.length,
      completed,
      previewCompleted,
      stoppedEarly,
      operationId: acceptedOperationId,
      items: results,
      remainingItemIndices: items.slice(results.length).map((_item, offset) => results.length + offset),
    },
  };
}

function groupFoodPlanItems(items: MultiDayFoodPlanItem[]) {
  const groups = new Map<string, { date: string; meal: string; items: MultiDayFoodPlanItem[]; itemIndices: number[] }>();
  items.forEach((item, index) => {
    const key = JSON.stringify([item.date, item.meal]);
    const group = groups.get(key) ?? { date: item.date, meal: item.meal, items: [], itemIndices: [] };
    group.items.push(item);
    group.itemIndices.push(index);
    groups.set(key, group);
  });
  return Array.from(groups.values());
}

function deterministicPlanKey(kind: string, value: unknown) {
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${kind}-plan-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function resultData(result: ProviderResult) {
  return result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
}

function successfulFoodPlanStatus(status: ProviderStatus) {
  return status === "written" || status === "already_exists";
}

function mustStopOrchestratedPlan(status: ProviderStatus) {
  return status === "accepted"
    || status === "possibly_written_verify_failed"
    || status === "busy"
    || status === "error";
}

function aggregateOrchestratedStatus(
  statuses: ProviderStatus[],
  expectedCount: number,
  succeeded: (status: ProviderStatus) => boolean,
): ProviderStatus {
  if (statuses.length === expectedCount && statuses.every(succeeded)) {
    return statuses.every((status) => status === "ok") ? "ok" : "written";
  }
  if (statuses.length === expectedCount && statuses.every((status) => status === "dry_run")) return "dry_run";
  for (const candidate of [
    "accepted",
    "possibly_written_verify_failed",
    "error",
    "busy",
    "not_written_login_paused",
    "not_written_ambiguous",
    "not_written_not_found",
    "needs_manual_step",
    "not_configured",
    "unsupported",
  ] as const) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "needs_manual_step";
}

export async function handleMcpHttpRequest(req: IncomingMessage, res: ServerResponse) {
  const authority = validateRequestAuthority(req);
  if (!authority.ok) {
    req.resume();
    res.writeHead(authority.status, { "content-type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "invalid_request_authority", message: authority.message }));
    return;
  }
  applyCorsResponseHeaders(req, res);

  const url = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);

  if (await handleOAuthRequest(req, res, url)) {
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
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
        provider: defaultProvider.name,
        mode: defaultProvider.mode,
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
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const auth = authorizeMcpRequest(req);
    if (!auth.ok) {
      rejectUnauthorized(req, res, auth.reason ?? "Unauthorized.");
      return;
    }

    const releaseRequestSlot = acquireMcpRequestSlot();
    if (!releaseRequestSlot) {
      req.resume();
      res.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "Retry-After": "1",
      }).end(JSON.stringify({
        error: "server_busy",
        message: `At most ${MAX_CONCURRENT_MCP_REQUESTS} MCP requests may run concurrently.`,
      }));
      return;
    }
    res.once("finish", releaseRequestSlot);
    res.once("close", releaseRequestSlot);

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
      let parsedBody: unknown;
      if (req.method === "POST") {
        const body = await readBoundedMcpJsonBody(req, res);
        if (!body.ok) return;
        parsedBody = body.value;
      }
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      if (res.writableEnded || res.destroyed) releaseRequestSlot();
    }
    return;
  }

  res.writeHead(404).end("Not Found");
}

export function createCronoHttpServer() {
  const server = createServer(handleMcpHttpRequest);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

function acquireMcpRequestSlot() {
  if (activeMcpRequests >= MAX_CONCURRENT_MCP_REQUESTS) return undefined;
  activeMcpRequests += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeMcpRequests = Math.max(0, activeMcpRequests - 1);
  };
}

async function readBoundedMcpJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const rawContentLength = headerValue(req.headers["content-length"]);
  if (rawContentLength !== undefined) {
    if (!/^\d+$/.test(rawContentLength)) {
      req.resume();
      writeMcpInputError(res, 400, "invalid_content_length", "Content-Length must be a non-negative integer.");
      return { ok: false };
    }
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength > MAX_MCP_REQUEST_BODY_BYTES) {
      req.resume();
      writeMcpInputError(res, 413, "request_too_large", `MCP request body exceeds ${MAX_MCP_REQUEST_BODY_BYTES} bytes.`);
      return { ok: false };
    }
  }

  return new Promise((resolve, reject) => {
    const buffer = Buffer.allocUnsafe(MAX_MCP_REQUEST_BODY_BYTES);
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const finish = (result: { ok: true; value: unknown } | { ok: false }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextSize = size + chunkBuffer.length;
      if (nextSize > MAX_MCP_REQUEST_BODY_BYTES) {
        cleanup();
        req.resume();
        writeMcpInputError(res, 413, "request_too_large", `MCP request body exceeds ${MAX_MCP_REQUEST_BODY_BYTES} bytes.`);
        finish({ ok: false });
        return;
      }
      chunkBuffer.copy(buffer, size);
      size = nextSize;
    };
    const onEnd = () => {
      try {
        const body = buffer.subarray(0, size).toString("utf8");
        finish({ ok: true, value: JSON.parse(body) });
      } catch {
        writeMcpInputError(res, 400, "parse_error", "MCP request body must contain valid JSON.");
        finish({ ok: false });
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      cleanup();
      reject(new Error("MCP request body was aborted."));
    };

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function writeMcpInputError(res: ServerResponse, status: number, error: string, message: string) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
    .end(JSON.stringify({ error, message }));
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function __acquireMcpRequestSlotForTests() {
  return acquireMcpRequestSlot();
}

export function __resetMcpConcurrencyForTests() {
  activeMcpRequests = 0;
}
