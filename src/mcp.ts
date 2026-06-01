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
  const server = new McpServer({ name: "cronogpt", version: "0.1.0" });

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
        ui: { resourceUri: widgetUri },
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
    "refresh_cronometer_session",
    "Refresh Cronometer browser session",
    "Opens Cronometer once to verify login and warm the hosted browser storage cache. Does not write diary data.",
    emptyInputSchema,
    { readOnlyHint: true, openWorldHint: true },
    async () => toMcpToolResponse(await provider.refreshSession()),
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
    "Searches Cronometer for each recipe ingredient so ChatGPT can map recipe text to real foods before creating a custom recipe.",
    {
      recipeName: z.string().optional(),
      ingredients: z.array(
        z.object({
          query: z.string().min(1),
          selectedName: z.string().optional(),
          amount: z.number().positive().optional(),
          unit: z.string().optional(),
        }),
      ),
      limitPerIngredient: z.number().int().positive().max(5).optional(),
      maxSeconds: z.number().int().positive().max(50).optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    async (args) => {
      return toMcpToolResponse(
        await provider.resolveRecipeIngredients({
          recipeName: args.recipeName as string | undefined,
          ingredients: args.ingredients as Array<{ query: string; selectedName?: string; amount?: number; unit?: string }>,
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
    "Creates a custom Cronometer food after validation and confirmation.",
    {
      name: z.string().min(1),
      servingSize: z.string().optional(),
      nutrients: z.record(z.number()).optional(),
      barcode: z.string().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.createCustomFood(args as never)),
  );

  registerReadPageTool(
    "list_custom_foods",
    "List custom foods",
    "Lists Cronometer Foods > Custom Foods.",
    emptyInputSchema,
    "#custom-foods",
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

  registerReadPageTool(
    "list_custom_recipes",
    "List custom recipes",
    "Lists Cronometer Foods > Custom Recipes.",
    emptyInputSchema,
    "#custom-recipes",
  );

  register(
    "create_recipe",
    "Create recipe",
    "Creates a custom Cronometer recipe after validation and confirmation.",
    {
      name: z.string().min(1),
      ingredients: z.array(
        z.object({
          query: z.string().min(1),
          selectedName: z.string().optional(),
          amount: z.number().positive().optional(),
          unit: z.string().optional(),
        }),
      ),
      servings: z.number().positive().optional(),
      servingName: z.string().optional(),
      dryRun: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => toMcpToolResponse(await provider.createRecipe(args as never)),
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

  registerFrameworkTool(
    "bulk_delete_entries",
    "Bulk delete entries",
    "Dangerous framework stub for Cronometer bulk delete.",
    { scope: z.string().optional(), dryRun: z.boolean().optional(), confirmed: z.boolean().optional() },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    "Bulk delete is intentionally disabled until a dedicated review and restore plan exists.",
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
