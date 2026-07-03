import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type {
  BiometricLogInput,
  Capability,
  CustomFoodDeleteInput,
  CustomFoodAndLogInput,
  CustomFoodDuplicateInput,
  CustomFoodInput,
  CustomFoodListInput,
  CustomFoodRetireInput,
  CustomFoodSelectorInput,
  CustomFoodUpdateInput,
  CustomRecipeSelectorInput,
  DateRangeInput,
  DiaryFoodDeleteInput,
  ExerciseLogInput,
  ExportDataInput,
  FastInput,
  FoodLogBatchInput,
  FoodLogInput,
  NoteLogInput,
  ProviderResult,
  RecipeDeleteInput,
  RecipeInput,
  RecipeRetireInput,
  RecipeUpdateInput,
  ResolveRecipeIngredientsInput,
  RepeatItemInput,
  SearchFoodsInput,
  StabilityCheckInput,
  TargetsInput,
  UiFlowInput,
  UiFlowStep,
} from "../domain.js";
import { BaseCronometerProvider } from "./base.js";
import { capabilitiesForMode } from "../features.js";
import { customFoodNutrientLabelForKey } from "../nutrients.js";
import {
  foodLogBatchIdempotencyKey,
  foodLogBrowserPreflightData,
  normalizeFoodLogDate,
  normalizeFoodLogInput,
  normalizeFoodLogMeal,
  normalizeFoodLogUnit,
  retryGuidanceForFoodLog,
  verifyFoodLogInDiaryText,
  type NormalizedFoodLog,
} from "../food-log-transaction.js";

export interface BrowserConfig {
  email?: string;
  password?: string;
  remoteWsEndpoint?: string;
  storageState?: string;
  localChromium: boolean;
  chromiumExecutablePath?: string;
  writeEnabled: boolean;
  requireFoodConfirmation: boolean;
  navigationTimeoutMs: number;
  loginBackoffMs: number;
  loginBackoffFile?: string;
  operationTimeoutMs: number;
  browserRetryCount: number;
  timeZone: string;
  browserProfileDir?: string;
  reuseRemoteContext?: boolean;
  reuseLocalBrowser?: boolean;
  strictAccountVerification?: boolean;
}

export interface SearchResult {
  name: string;
  source?: string;
  raw: string;
}

interface DiaryDateStatus {
  requestedDate?: string;
  normalizedDate?: string;
  currentDate: string;
  appliedDate: string;
  selected: boolean;
  strategy: "current" | "today" | "arrow" | "invalid" | "out_of_range" | "failed";
  steps?: number;
  warning?: string;
}

interface NormalizedDiaryFoodDelete {
  original: DiaryFoodDeleteInput;
  date: string;
  meal: string;
  name: string;
  amount?: number;
  unit?: string;
}

interface DiaryFoodEntryMatch {
  entryText: string;
}

interface FoodSearchOutcome {
  results: SearchResult[];
  dateStatus: DiaryDateStatus;
}

interface CustomFoodDetail {
  foodId?: string;
  name: string;
  listIndex?: number;
  occurrence?: number;
  servingSize?: string;
  energy?: { value: number; unit: string };
  macros?: Record<string, { value: number; unit: string }>;
  nutrients?: Record<string, { value: number; unit: string; percentDailyValue?: number }>;
  rawText?: string;
}

interface CustomRecipeDetail {
  recipeId?: string;
  name: string;
  listIndex?: number;
  occurrence?: number;
  servingName?: string;
  servings?: number;
  ingredients?: Array<{
    name: string;
    database?: string;
    amount?: number;
    unit?: string;
    energyKcal?: number;
    weight?: string;
  }>;
  rawText?: string;
}

interface BrowserSession {
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  closeContext?: boolean;
  closeBrowser?: boolean;
}

interface BackgroundBrowserJob {
  id: string;
  key: string;
  feature: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  updatedAt: number;
  input: unknown;
  result?: ProviderResult;
  error?: string;
}

interface ParsedStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

const CRONOMETER_ORIGIN = "https://cronometer.com";
const BROWSER_VIEWPORT = { width: 1024, height: 768 };
const DIARY_MEAL_SECTION_RE = /\b(Breakfast|Lunch|Dinner|Snacks|Supplements)\b/i;
const MAX_DIARY_ARROW_DAYS = 45;
const ACCOUNT_VERIFICATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FOOD_WRITE_WAIT_SECONDS = 75;
const DEFAULT_BATCH_WRITE_WAIT_SECONDS = 120;
const DEFAULT_CUSTOM_WRITE_WAIT_SECONDS = 180;
const CRONOMETER_PAGE_HASHES = {
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
} as const;
let cachedStorageState: ParsedStorageState | undefined;
let loginBackoffUntil = 0;
let lastLoginFailure: string | undefined;
let browserQueue: Promise<void> = Promise.resolve();
let activeBrowserJobs = 0;
let queuedBrowserJobs = 0;
let browserJobSeq = 0;
let browserQueueEpoch = 0;
let activeBrowserJob: { id: number; feature: string; startedAt: number; staleJobMs?: number } | undefined;
const queuedBrowserJobEntries = new Map<number, { feature: string; enqueuedAt: number }>();
let backgroundBrowserJobSeq = 0;
const backgroundBrowserJobs = new Map<string, BackgroundBrowserJob>();
const backgroundBrowserJobKeys = new Map<string, string>();
let cachedLocalSession: BrowserSession | undefined;
let cachedAccountVerification: { normalizedEmail: string; verifiedAt: number; source: string } | undefined;

interface StorageStateInfo {
  configured: boolean;
  usable: boolean;
  source: "warm-cache" | "env" | "none" | "invalid";
  cookieCount?: number;
  originCount?: number;
  state?: ParsedStorageState;
}

export class BrowserCronometerProvider extends BaseCronometerProvider {
  constructor(private readonly config: BrowserConfig) {
    super("browser", "browser");
  }

  async capabilities(): Promise<ProviderResult<Capability[]>> {
    const storageStateInfo = this.storageStateInfo();
    const hasLoginPath = Boolean((this.config.email && this.config.password) || storageStateInfo.usable);
    const browserConfigured = Boolean(this.hasRunnableBrowser() && hasLoginPath);
    const capabilities = capabilitiesForMode("browser").map((capability) => {
      if (capability.preferredBackend === "manual") {
        return { ...capability, currentBackendStatus: "unsupported" as const };
      }
      if (!browserConfigured && capability.currentBackendStatus !== "unsupported") {
        return { ...capability, currentBackendStatus: "not_configured" as const };
      }
      return capability;
    });

    return this.result(
      "cronometer_capabilities",
      browserConfigured ? "ok" : "not_configured",
      capabilities,
      browserConfigured ? undefined : "Set CRONOMETER_STORAGE_STATE_BASE64 or Cronometer credentials, and enable local Chromium or provide REMOTE_CHROME_WS_ENDPOINT.",
    );
  }

  async runtimeStatus(): Promise<ProviderResult> {
    const now = Date.now();
    const queue = releaseAndSnapshotBrowserQueue(this.config.operationTimeoutMs + this.featureQueueWaitTimeoutMs("log_food"));
    const loginBackoff = this.currentLoginBackoff();
    const loginPaused = now < loginBackoff.until;
    const storageStateInfo = this.storageStateInfo();
    const expectedAccountEmail = normalizeEmail(this.config.email);
    const accountVerificationCached = Boolean(
      expectedAccountEmail
        && cachedAccountVerification
        && cachedAccountVerification.normalizedEmail === expectedAccountEmail
        && now - cachedAccountVerification.verifiedAt < ACCOUNT_VERIFICATION_TTL_MS,
    );
    return this.result("cronometer_runtime_status", "ok", {
      provider: this.name,
      mode: this.mode,
      browserConfigured: this.hasRunnableBrowser(),
      hasCredentials: Boolean(this.config.email && this.config.password),
      hasRemoteBrowser: Boolean(this.config.remoteWsEndpoint),
      localChromium: this.config.localChromium,
      chromiumExecutablePathConfigured: Boolean(this.config.chromiumExecutablePath),
      storageStateConfigured: Boolean(this.config.storageState),
      storageStateUsable: storageStateInfo.usable,
      storageStateSource: storageStateInfo.source,
      storageStateCookieCount: storageStateInfo.cookieCount,
      storageStateOriginCount: storageStateInfo.originCount,
      warmStorageStateCached: Boolean(cachedStorageState),
      expectedAccountConfigured: Boolean(this.config.email),
      expectedAccount: redactEmail(this.config.email),
      accountVerificationCached,
      accountVerificationSource: cachedAccountVerification?.source,
      strictAccountVerification: Boolean(this.config.strictAccountVerification),
      writeEnabled: this.config.writeEnabled,
      requireFoodConfirmation: this.config.requireFoodConfirmation,
      activeBrowserJobs: queue.activeBrowserJobs,
      queuedBrowserJobs: queue.queuedBrowserJobs,
      activeBrowserJob: queue.activeBrowserJob,
      queuedBrowserJobSample: queue.queuedBrowserJobSample,
      staleActiveJob: queue.staleActiveJob,
      backgroundBrowserJobs: summarizeBackgroundBrowserJobs(now),
      operationTimeoutMs: this.config.operationTimeoutMs,
      browserRetryCount: this.config.browserRetryCount,
      browserProfileDirConfigured: Boolean(this.config.browserProfileDir),
      reuseLocalBrowser: this.config.reuseLocalBrowser,
      loginPaused,
      loginPauseSecondsRemaining: loginPaused ? Math.ceil((loginBackoff.until - now) / 1000) : 0,
      loginBackoffSource: loginBackoff.source,
      loginBackoffFileConfigured: Boolean(this.config.loginBackoffFile),
      lastLoginFailure: loginBackoff.reason,
      guidance: [
        "Use dryRun=true for validation and previews; dry-run write tools do not open Cronometer.",
        "Use refresh_cronometer_session only as an optional read-only warmup; do not block a confirmed create_and_log_custom_food workflow on it.",
        "Confirmed log_food writes run as background jobs; poll cronometer_runtime_status until the job is completed before retrying.",
        "Use log_foods for multi-ingredient meals; it submits one idempotent batch and reports per-item write status.",
        "Confirmed create_and_log_custom_food writes run as background jobs; poll cronometer_runtime_status until the job is completed before retrying.",
        "Use resolve_recipe_ingredients with a low limitPerIngredient and a larger maxSeconds value for large recipes.",
        "If loginPaused is true and storageStateUsable is false, wait or provide durable storage state/remote browser before retrying browser actions. Usable storage state may still allow non-login browser actions during cooldown.",
        "For the most reliable hosted writes, configure a persistent remote browser or CRONOMETER_STORAGE_STATE_BASE64.",
      ],
    });
  }

  async refreshSession(): Promise<ProviderResult> {
    return this.withPage("refresh_cronometer_session", async (page) => {
      await this.openApp(page, "#diary");
      const state = await page.context().storageState();
      cachedStorageState = state;
      const visibleText = await this.visibleText(page).catch(() => "");
      return this.result("refresh_cronometer_session", "ok", {
        loggedIn: await this.isLoggedIn(page, visibleText),
        warmStorageStateCached: true,
        storageStateCookieCount: state.cookies.length,
        storageStateOriginCount: state.origins.length,
        visibleSignals: {
          hasDiary: /\bDiary\b/i.test(visibleText),
          hasFoods: /\bFoods\b/i.test(visibleText),
          hasDashboard: /\bDashboard\b/i.test(visibleText),
        },
      });
    });
  }

  async stabilityCheck(input: StabilityCheckInput): Promise<ProviderResult> {
    const foodQuery = input.foodQuery?.trim() || "Banana cream";
    const includeFoodSearch = input.includeFoodSearch !== false;

    return this.withPage("cronometer_stability_check", async (page) => {
      const startedAt = Date.now();
      await this.openApp(page, "#diary");
      const diaryText = await this.waitForDiaryText(page);
      const checks = {
        loggedIn: await this.isLoggedIn(page, diaryText),
        diaryReadable: /\bDiary\b/i.test(diaryText),
        hasMealSections: hasDiaryMealSections(diaryText),
        hasNavigation: /\b(Dashboard|Diary|Trends|Foods)\b/i.test(diaryText),
      };

      let foodSearch: { query: string; resultCount: number; firstResult?: SearchResult } | undefined;
      if (includeFoodSearch) {
        const { results } = await this.searchFoodUi(page, foodQuery, 3);
        foodSearch = {
          query: foodQuery,
          resultCount: results.length,
          firstResult: results[0],
        };
      }

      const ready = checks.loggedIn && checks.diaryReadable && checks.hasMealSections && checks.hasNavigation && (!includeFoodSearch || Boolean(foodSearch?.resultCount));
      return this.result("cronometer_stability_check", ready ? "ok" : "needs_manual_step", {
        ready,
        elapsedMs: Date.now() - startedAt,
        checks,
        foodSearch,
        diaryText: ready ? undefined : compactText(diaryText, 8000),
        runtime: {
          storageStateConfigured: Boolean(this.config.storageState),
          warmStorageStateCached: Boolean(cachedStorageState),
          activeBrowserJobs,
          queuedBrowserJobs,
          operationTimeoutMs: this.config.operationTimeoutMs,
          browserRetryCount: this.config.browserRetryCount,
        },
      }, ready ? undefined : "Cronometer preflight did not pass every readiness check.");
    });
  }

  async readFeaturePage(feature: string, hash: string, input: unknown) {
    return this.readPage(feature, hash, input);
  }

  async runUiFlow(input: UiFlowInput): Promise<ProviderResult> {
    const steps = input.steps.slice(0, 20);
    const hash = CRONOMETER_PAGE_HASHES[input.section] ?? "#diary";

    if (input.dryRun !== false || !input.confirmed) {
      return this.withPage("run_cronometer_ui_flow", async (page) => {
        await this.openApp(page, hash);
        return this.result("run_cronometer_ui_flow", "dry_run", {
          input: safeInput({ ...input, steps }),
          hash,
          plannedStepCount: steps.length,
          nextStep: "Review the visible page and planned steps, then call again with dryRun=false and confirmed=true to execute non-dangerous UI actions.",
          visibleText: compactText(await this.visibleText(page), 12000),
        });
      });
    }

    const blocked = steps.find((step) => step.action === "clickText" && isDangerousClickText(step.text ?? ""));
    if (blocked) {
      return this.result("run_cronometer_ui_flow", "needs_manual_step", {
        input: safeInput({ ...input, steps }),
        blockedStep: blocked,
      }, "This generic UI flow refuses dangerous click text. Use a dedicated reviewed tool for destructive account or bulk-delete actions.");
    }

    return this.withPage("run_cronometer_ui_flow", async (page) => {
      await this.openApp(page, hash);
      const executed = [];
      for (const [index, step] of steps.entries()) {
        const result = await runUiStep(page, step);
        executed.push({ index, step: safeInput(step), ...result });
        if (result.status !== "ok") break;
      }

      const allOk = executed.every((step) => step.status === "ok");
      return this.result("run_cronometer_ui_flow", allOk ? "ok" : "needs_manual_step", {
        input: safeInput({ ...input, steps }),
        hash,
        executed,
        visibleText: compactText(await this.visibleText(page), 12000),
      }, allOk ? undefined : "One or more UI-flow steps could not be completed with stable selectors.");
    });
  }

  async getDailySummary(input: DateRangeInput) {
    return this.withPage("get_daily_summary", async (page) => {
      const dateStatus = await this.openDiary(page, input.date);
      const rawText = await this.waitForDiaryText(page);
      return this.result("get_daily_summary", dateStatus.selected ? "ok" : "needs_manual_step", {
        date: dateStatus.appliedDate,
        dateStatus,
        summary: parseDailySummary(rawText),
        rawText: compactText(rawText, 18000),
      }, dateStatus.warning);
    });
  }

  async listFoodEntries(input: DateRangeInput) {
    return this.readDiarySection("list_food_entries", input, ["Breakfast", "Lunch", "Dinner", "Snacks", "Supplements"]);
  }

  async listBiometrics(input: DateRangeInput) {
    return this.readDiarySection("list_biometrics", input, ["Health", "Biometric", "Weight", "Heart Rate", "Sleep"]);
  }

  async listExercises(input: DateRangeInput) {
    return this.readDiarySection("list_exercises", input, ["Walking", "Exercise", "Activity"]);
  }

  async listNotes(input: DateRangeInput) {
    return this.readDiarySection("list_notes", input, ["Note", "Notes"]);
  }

  async searchFoods(input: SearchFoodsInput) {
    return this.withPage("search_foods", async (page) => {
      const outcome = await this.searchFoodUi(page, input.query, input.limit ?? 10, undefined, {
        searchScope: input.searchScope,
        selectedSource: input.selectedSource,
      });
      const results = rankFoodResults(input.query, outcome.results, undefined, input.selectedSource);
      const selection = chooseFoodLogResult({ query: input.query }, results);
      return this.result("search_foods", "ok", {
        query: input.query,
        searchScope: input.searchScope ?? "auto",
        selectedSource: input.selectedSource,
        results,
        selection,
      });
    });
  }

  async resolveRecipeIngredients(input: ResolveRecipeIngredientsInput) {
    const limit = Math.min(input.limitPerIngredient ?? 3, 5);
    const operationBudgetMs = Math.max(30000, this.config.operationTimeoutMs - 15000);
    const maxMs = Math.min((input.maxSeconds ?? 180) * 1000, operationBudgetMs, 900000);
    return this.withPage("resolve_recipe_ingredients", async (page) => {
      const startedAt = Date.now();
      const deadline = startedAt + maxMs;
      await this.openFoodSearchDialog(page);
      await clickFoodDialogFilter(page, "All").catch(() => undefined);

      const resolved = [];
      let stoppedEarly = false;

      for (const ingredient of input.ingredients) {
        if (Date.now() > deadline - 4500) {
          stoppedEarly = true;
          resolved.push({
            ingredient,
            status: "skipped",
            warning: "Skipped before the hosted operation budget expired. Call resolve_recipe_ingredients again with the remaining ingredients.",
            matches: { query: ingredient.query, results: [] },
          });
          continue;
        }

        let results = rankFoodResults(
          ingredient.query,
          await searchCurrentFoodDialog(page, ingredient.query, limit),
          ingredient.selectedName,
          ingredient.selectedSource,
        );
        if (results.length === 0 && Date.now() < deadline - 6500) {
          const customClicked = await clickFoodDialogFilter(page, "Custom");
          if (customClicked) {
            results = rankFoodResults(
              ingredient.query,
              await searchCurrentFoodDialog(page, ingredient.query, limit),
              ingredient.selectedName,
              ingredient.selectedSource,
            );
            await clickFoodDialogFilter(page, "All").catch(() => undefined);
          }
        }

        resolved.push({
          ingredient,
          status: results.length > 0 ? "ok" : "needs_manual_step",
          warning: results.length > 0 ? undefined : "No Cronometer matches were found for this ingredient.",
          matches: { query: ingredient.query, recommended: results[0], results },
        });
      }

      const elapsedMs = Date.now() - startedAt;
      const allResolved = resolved.every((item) => item.status === "ok");
      return this.result("resolve_recipe_ingredients", allResolved && !stoppedEarly ? "ok" : "needs_manual_step", {
        recipeName: input.recipeName,
        limitPerIngredient: limit,
        elapsedMs,
        stoppedEarly,
        resolved,
        nextStep: stoppedEarly
          ? "Call resolve_recipe_ingredients again with only the skipped or unresolved ingredients."
          : "Pick the matching Cronometer food for each ingredient, then call create_recipe with confirmed=true when ready to write.",
      });
    });
  }

  async logFood(input: FoodLogInput & { confirmed?: boolean }) {
    const normalized = normalizeFoodLogInput(input, this.config.timeZone);
    const preflightData = foodLogBrowserPreflightData(normalized);

    if (input.dryRun === true) {
      return this.result("log_food", "dry_run", {
        ...preflightData,
        input: safeInput(input),
        browserOpened: false,
        writeAttempted: false,
        verification: {
          status: "not_attempted",
          reason: "Dry-run requested; no browser was opened.",
        },
        retry: retryGuidanceForFoodLog("dry_run"),
      });
    }

    const loginBackoff = this.currentLoginBackoff();
    if (Date.now() < loginBackoff.until && !this.storageStateInfo().usable) {
      const waitSeconds = Math.ceil((loginBackoff.until - Date.now()) / 1000);
      return this.loginPausedResult("log_food", waitSeconds, loginBackoff.reason, {
        ...preflightData,
        input: safeInput(input),
        browserOpened: false,
        writeAttempted: false,
      });
    }

    const willAttemptWrite =
      this.config.writeEnabled &&
      input.confirmed !== false &&
      (!this.config.requireFoodConfirmation || input.confirmed === true);
    if (willAttemptWrite) {
      const backgroundKey = backgroundBrowserJobKey("log_food", {
        idempotencyKey: normalized.idempotencyKey,
      });
      const accepted = this.startBackgroundBrowserJob(
        "log_food",
        backgroundKey,
        {
          ...preflightData,
          input: safeInput(input),
        },
        () => this.withPage("log_food", (page) => this.logFoodOnPage(page, input, normalized, preflightData)),
      );
      return this.waitForAcceptedBackgroundJob(
        "log_food",
        accepted,
        input.waitForCompletionSeconds ?? DEFAULT_FOOD_WRITE_WAIT_SECONDS,
      );
    }

    return this.withPage("log_food", (page) => this.logFoodOnPage(page, input, normalized, preflightData));
  }

  async logFoods(input: FoodLogBatchInput & { confirmed?: boolean }) {
    const normalizedItems = normalizeFoodLogBatchItems(input, this.config.timeZone);
    const batchIdempotencyKey = input.idempotencyKey?.trim() || foodLogBatchIdempotencyKey(
      normalizedItems.map((item) => item.normalized),
    );
    const batchPreflightData = {
      batchIdempotencyKey,
      count: normalizedItems.length,
      items: normalizedItems.map((item) => ({
        index: item.index,
        normalized: foodLogBrowserPreflightData(item.normalized).normalized,
      })),
    };

    if (normalizedItems.length === 0) {
      return this.result("log_foods", "needs_manual_step", {
        ...batchPreflightData,
        input: safeInput(input),
        browserOpened: false,
        writeAttempted: false,
      }, "log_foods requires at least one food item.");
    }

    if (input.dryRun === true) {
      return this.result("log_foods", "dry_run", {
        ...batchPreflightData,
        input: safeInput(input),
        browserOpened: false,
        writeAttempted: false,
        verification: {
          status: "not_attempted",
          reason: "Dry-run requested; no browser was opened.",
        },
        nextStep: "Call log_foods again without dryRun=true to write the whole batch as one idempotent browser job.",
      });
    }

    const loginBackoff = this.currentLoginBackoff();
    if (Date.now() < loginBackoff.until && !this.storageStateInfo().usable) {
      const waitSeconds = Math.ceil((loginBackoff.until - Date.now()) / 1000);
      return this.loginPausedResult("log_foods", waitSeconds, loginBackoff.reason, {
        ...batchPreflightData,
        input: safeInput(input),
        browserOpened: false,
        writeAttempted: false,
      });
    }

    const willAttemptWrite =
      this.config.writeEnabled &&
      input.confirmed !== false &&
      (!this.config.requireFoodConfirmation || input.confirmed === true);
    if (!willAttemptWrite) {
      return this.result("log_foods", "dry_run", {
        ...batchPreflightData,
        input: safeInput(input),
        browserOpened: false,
        writeAttempted: false,
        reason: writeGateReasonForFoodLog(input, this.config.writeEnabled, this.config.requireFoodConfirmation),
        nextStep: this.config.requireFoodConfirmation
          ? "Call log_foods with confirmed=true after reviewing the normalized batch."
          : "Enable CRONOMETER_ENABLE_WRITES=true, then call log_foods again to write the batch.",
      });
    }

    const backgroundKey = backgroundBrowserJobKey("log_foods", {
      idempotencyKey: batchIdempotencyKey,
    });
    const accepted = this.startBackgroundBrowserJob(
      "log_foods",
      backgroundKey,
      {
        ...batchPreflightData,
        input: safeInput(input),
      },
      () => this.withPage("log_foods", (page) => this.logFoodsOnPage(page, input, normalizedItems, batchIdempotencyKey)),
    );

    return this.waitForAcceptedBackgroundJob(
      "log_foods",
      accepted,
      input.waitForCompletionSeconds ?? DEFAULT_BATCH_WRITE_WAIT_SECONDS,
    );
  }

  private async logFoodsOnPage(
    page: Page,
    input: FoodLogBatchInput & { confirmed?: boolean },
    normalizedItems: ReturnType<typeof normalizeFoodLogBatchItems>,
    batchIdempotencyKey: string,
  ): Promise<ProviderResult> {
    const startedAt = Date.now();
    const itemResults = [];
    let stoppedEarly = false;

    for (const item of normalizedItems) {
      const result = await this.logFoodOnPage(
        page,
        item.input,
        item.normalized,
        foodLogBrowserPreflightData(item.normalized),
      );
      const summary = summarizeBatchFoodLogResult(item.index, item.normalized, result);
      itemResults.push(summary);

      if (input.stopOnFirstFailure === true && !foodLogBatchItemSucceeded(result.status)) {
        stoppedEarly = true;
        break;
      }
    }

    const counts = countBatchFoodLogStatuses(itemResults.map((item) => item.status));
    const status = batchFoodLogStatus(itemResults.map((item) => item.status), normalizedItems.length);
    const completed = itemResults.length === normalizedItems.length && itemResults.every((item) => foodLogBatchItemSucceeded(item.status));
    const warning = batchFoodLogWarning(status, itemResults.length, normalizedItems.length, counts);

    return this.result("log_foods", status, {
      batchIdempotencyKey,
      count: normalizedItems.length,
      attemptedCount: itemResults.length,
      completed,
      stoppedEarly,
      elapsedMs: Date.now() - startedAt,
      browserOpened: true,
      writeAttempted: true,
      counts,
      items: itemResults,
      retry: status === "written"
        ? "No retry needed; every batch item was written or already existed."
        : "Do not blindly retry the full batch. Inspect items and retry only entries that are not written, not already_exists, and not possibly_written_verify_failed.",
    }, warning);
  }

  private async logFoodOnPage(
    page: Page,
    input: FoodLogInput & { confirmed?: boolean },
    normalized: NormalizedFoodLog,
    preflightData: ReturnType<typeof foodLogBrowserPreflightData>,
  ): Promise<ProviderResult> {
    const requested = normalizedToFoodInput(normalized, input);
    const initialDateStatus = await this.openDiary(page, normalized.date);
    const beforeDiaryText = await this.visibleText(page).catch(() => "");
    const beforeVerification = verifyFoodLogInDiaryText(beforeDiaryText, normalized);
    if (!initialDateStatus.selected) {
      return this.result(
        "log_food",
        "error",
        {
          ...preflightData,
          input: safeInput(input),
          browserOpened: true,
          writeAttempted: false,
          dateStatus: initialDateStatus,
          verification: beforeVerification,
          retry: retryGuidanceForFoodLog("error"),
        },
        initialDateStatus.warning ?? "Could not apply the requested diary date. No write was attempted.",
      );
    }

    if (beforeVerification.status === "verified") {
      return this.result("log_food", "already_exists", {
        ...preflightData,
        input: safeInput(input),
        browserOpened: true,
        writeAttempted: false,
        dateStatus: initialDateStatus,
        verification: beforeVerification,
        retry: retryGuidanceForFoodLog("already_exists"),
      });
    }

    const foodSearch = await this.searchFoodForLog(page, normalized, requested, input);
    const { preview, dateStatus, queryUsed } = foodSearch;
    if (!dateStatus.selected) {
      return this.result(
        "log_food",
        "error",
        {
          ...preflightData,
          input: safeInput(input),
          browserOpened: true,
          writeAttempted: false,
          dateStatus,
          queryUsed,
          retry: retryGuidanceForFoodLog("error"),
        },
        dateStatus.warning ?? "Could not apply the requested diary date. No write was attempted.",
      );
    }

    if (preview.length === 0) {
      return this.result("log_food", "not_written_not_found", {
        ...preflightData,
        input: safeInput(input),
        dateStatus,
        preview,
        browserOpened: true,
        writeAttempted: false,
        queryUsed,
        retry: retryGuidanceForFoodLog("not_written_not_found"),
      }, "No matching Cronometer food result was found.");
    }

    const selection = chooseFoodLogResult({ ...requested, query: queryUsed }, preview);
    const shouldWrite =
      this.config.writeEnabled &&
      input.dryRun !== true &&
      input.confirmed !== false &&
      (!this.config.requireFoodConfirmation || input.confirmed === true);

    if (!shouldWrite) {
      const reason = writeGateReasonForFoodLog(input, this.config.writeEnabled, this.config.requireFoodConfirmation);
      return this.result("log_food", "dry_run", {
        ...preflightData,
        input: safeInput(input),
        dateStatus,
        preview,
        selection,
        browserOpened: true,
        writeAttempted: false,
        queryUsed,
        reason,
        nextStep: selection.result
          ? "Review the selectedName/selectedSource, then call again without dryRun=true to write the explicit food log."
          : selection.nextStep,
      }, selection.result ? undefined : selection.warning);
    }

    if (!selection.result) {
      return this.result(
        "log_food",
        "not_written_ambiguous",
        {
          ...preflightData,
          input: safeInput(input),
          dateStatus,
          preview,
          selection,
          browserOpened: true,
          writeAttempted: false,
          queryUsed,
          retry: retryGuidanceForFoodLog("not_written_ambiguous"),
          nextStep: selection.nextStep,
        },
        selection.warning,
      );
    }

    const selectedName = selection.result.name;
    const selectedSource = selection.result.source;
    const clicked = await clickFoodSearchResult(page, selectedName, selectedSource);
    if (!clicked) {
      return this.result(
        "log_food",
        "not_written_ambiguous",
        {
          ...preflightData,
          input: safeInput(input),
          selectedName,
          selectedSource,
          preview,
          selection,
          browserOpened: true,
          writeAttempted: false,
          queryUsed,
          retry: retryGuidanceForFoodLog("not_written_ambiguous"),
        },
        "Found food candidates but could not select one with stable UI selectors.",
      );
    }

    await page.waitForTimeout(1000);
    await fillFoodTime(page, input.timestamp);
    const unitFill = await fillFoodUnit(page, normalized.unit);
    if (!unitFill.filled) {
      return this.result(
        "log_food",
        "needs_manual_step",
        {
          ...preflightData,
          input: safeInput(input),
          selectedName,
          selectedSource,
          selection,
          unitFill,
          browserOpened: true,
          writeAttempted: false,
          queryUsed,
          retry: retryGuidanceForFoodLog("needs_manual_step"),
        },
        unitFill.warning ?? `Could not select requested unit ${normalized.unit}. No food was written.`,
      );
    }
    const amountFill = await fillFoodAmount(page, normalized.amount);
    if (!amountFill.filled) {
      return this.result(
        "log_food",
        "needs_manual_step",
        {
          ...preflightData,
          input: safeInput(input),
          selectedName,
          selectedSource,
          selection,
          unitFill,
          amountFill,
          browserOpened: true,
          writeAttempted: false,
          queryUsed,
          retry: retryGuidanceForFoodLog("needs_manual_step"),
        },
        amountFill.warning ?? `Could not fill requested amount ${normalized.amount}. No food was written.`,
      );
    }
    await chooseMeal(page, normalized.meal);

    const saved = await clickDialogButton(page, /^(ADD|ADD TO DIARY|ADD TO DIARY|SAVE|DONE)$/i);
    if (!saved) {
      return this.result(
        "log_food",
        "possibly_written_verify_failed",
        {
          ...preflightData,
          input: safeInput(input),
          selectedName,
          selectedSource,
          browserOpened: true,
          writeAttempted: true,
          queryUsed,
          retry: retryGuidanceForFoodLog("possibly_written_verify_failed"),
        },
        "Selected the food but could not find a stable add/save button. Nothing was intentionally saved.",
      );
    }

    await page.waitForTimeout(1500);
    const afterText = await this.waitForDiaryText(page).catch(() => "");
    const verification = verifyFoodLogInDiaryText(afterText || await this.visibleText(page).catch(() => ""), {
      ...normalized,
      selectedName,
      selectedSource,
    });
    const status = verification.status === "verified" ? "written" : "possibly_written_verify_failed";
    return this.result("log_food", status, {
      ...preflightData,
      logged: { ...safeInput(input), selectedName, selectedSource },
      dateStatus,
      selection,
      unitFill,
      amountFill,
      browserOpened: true,
      writeAttempted: true,
      queryUsed,
      verification,
      retry: retryGuidanceForFoodLog(status),
      visibleText: verification.status === "verified" ? undefined : compactText(await this.visibleText(page).catch(() => ""), 6000),
    }, verification.status === "verified" ? undefined : "Food may have been written, but read-back verification did not find the exact entry. Do not blindly retry.");
  }

  async deleteDiaryFoodEntry(input: DiaryFoodDeleteInput & { confirmed?: boolean }) {
    const target = normalizeDiaryFoodDeleteInput(input, this.config.timeZone);
    const confirmedDelete = input.dryRun === false && input.confirmed === true;
    if (confirmedDelete) {
      const backgroundKey = backgroundBrowserJobKey("delete_diary_food_entry", {
        date: target.date,
        meal: target.meal,
        name: target.name,
        amount: target.amount,
        unit: target.unit,
        confirmName: input.confirmName,
      });
      const accepted = this.startBackgroundBrowserJob(
        "delete_diary_food_entry",
        backgroundKey,
        safeInput(input),
        () => this.runDeleteDiaryFoodEntry(input),
      );
      return this.waitForAcceptedBackgroundJob(
        "delete_diary_food_entry",
        accepted,
        input.waitForCompletionSeconds ?? DEFAULT_CUSTOM_WRITE_WAIT_SECONDS,
      );
    }
    return this.runDeleteDiaryFoodEntry(input);
  }

  private async runDeleteDiaryFoodEntry(input: DiaryFoodDeleteInput & { confirmed?: boolean }) {
    const target = normalizeDiaryFoodDeleteInput(input, this.config.timeZone);
    if (!target.name) {
      return this.result("delete_diary_food_entry", "error", {
        input: safeInput(input),
        browserOpened: false,
        writeAttempted: false,
      }, "Missing diary food name.");
    }

    return this.withPage("delete_diary_food_entry", async (page) => {
      const dateStatus = await this.openDiary(page, target.date);
      const beforeText = await this.waitForDiaryText(page).catch(async () => await this.visibleText(page).catch(() => ""));
      const matches = findDiaryFoodEntryMatches(beforeText, target);
      const preview = {
        target: safeInput(target),
        matchCount: matches.length,
        matches: matches.map((match) => ({ entryText: compactText(match.entryText, 500) })),
      };

      if (!dateStatus.selected) {
        return this.result(
          "delete_diary_food_entry",
          "error",
          {
            input: safeInput(input),
            dateStatus,
            preview,
            browserOpened: true,
            writeAttempted: false,
          },
          dateStatus.warning ?? "Could not apply the requested diary date. No delete was attempted.",
        );
      }

      if (matches.length === 0) {
        return this.result("delete_diary_food_entry", "ok", {
          input: safeInput(input),
          dateStatus,
          preview,
          deleted: false,
          alreadyAbsent: true,
          browserOpened: true,
          writeAttempted: false,
        });
      }

      if (input.dryRun !== false || !input.confirmed) {
        return this.result("delete_diary_food_entry", "dry_run", {
          input: safeInput(input),
          dateStatus,
          preview,
          browserOpened: true,
          writeAttempted: false,
          nextStep: "Review the exact match, then call delete_diary_food_entry with dryRun=false, confirmed=true, and confirmName equal to the diary food name.",
        });
      }

      if (input.confirmName?.trim() !== target.name) {
        return this.result("delete_diary_food_entry", "needs_manual_step", {
          input: safeInput(input),
          dateStatus,
          preview,
          browserOpened: true,
          writeAttempted: false,
          nextStep: `Set confirmName exactly to ${target.name}.`,
        }, "Diary food delete requires confirmName to match the target food name exactly.");
      }

      if (matches.length > 1) {
        return this.result("delete_diary_food_entry", "needs_manual_step", {
          input: safeInput(input),
          dateStatus,
          preview,
          browserOpened: true,
          writeAttempted: false,
          nextStep: "Narrow the delete request with amount and unit, or delete manually from Cronometer.",
        }, "Multiple matching diary entries were found in the requested meal. No delete was attempted.");
      }

      const clicked = await clickDiaryFoodEntryRow(page, target, matches[0]);
      if (!clicked.clicked) {
        return this.result("delete_diary_food_entry", "needs_manual_step", {
          input: safeInput(input),
          dateStatus,
          preview,
          click: clicked,
          browserOpened: true,
          writeAttempted: false,
        }, clicked.warning ?? "Could not select the matching diary row with stable UI selectors.");
      }

      const deleteTrigger = await triggerSelectedDiaryEntryDelete(page);
      const confirmation = await confirmSelectedDiaryEntryDelete(page);
      if (!confirmation.confirmed) {
        return this.result("delete_diary_food_entry", "needs_manual_step", {
          input: safeInput(input),
          dateStatus,
          preview,
          click: clicked,
          deleteTrigger,
          deleteConfirmation: confirmation,
          browserOpened: true,
          writeAttempted: false,
        }, confirmation.warning ?? "Cronometer did not show the expected selected-entry delete confirmation.");
      }

      await page.waitForTimeout(2500);
      const afterText = await this.waitForDiaryText(page).catch(async () => await this.visibleText(page).catch(() => ""));
      const remainingMatches = findDiaryFoodEntryMatches(afterText, target);
      return this.result("delete_diary_food_entry", remainingMatches.length === 0 ? "ok" : "needs_manual_step", {
        input: safeInput(input),
        dateStatus,
        preview,
        click: clicked,
        deleteTrigger,
        deleteConfirmation: confirmation,
        deleted: remainingMatches.length === 0,
        remainingMatchCount: remainingMatches.length,
        browserOpened: true,
        writeAttempted: true,
        afterText: remainingMatches.length === 0 ? undefined : compactText(afterText, 4000),
      }, remainingMatches.length === 0 ? undefined : "Delete was attempted, but the matching diary entry still appears after read-back.");
    });
  }

  private async searchFoodForLog(
    page: Page,
    normalized: NormalizedFoodLog,
    requested: FoodLogInput,
    original: FoodLogInput,
  ) {
    let lastOutcome: FoodSearchOutcome | undefined;
    let lastQuery = normalized.searchQueries[0] ?? normalized.query;
    for (const query of normalized.searchQueries) {
      lastQuery = query;
      const outcome = await this.searchFoodUi(page, query, 5, normalized.date, {
        searchScope: original.searchScope,
        selectedSource: original.selectedSource,
      });
      lastOutcome = outcome;
      if (outcome.results.length > 0 || !outcome.dateStatus.selected) {
        return { preview: outcome.results, dateStatus: outcome.dateStatus, queryUsed: query };
      }
    }
    const fallbackDateStatus = lastOutcome?.dateStatus ?? await this.openDiary(page, normalized.date);
    return { preview: lastOutcome?.results ?? [], dateStatus: fallbackDateStatus, queryUsed: lastQuery };
  }

  async logExercise(input: ExerciseLogInput & { confirmed?: boolean }) {
    return this.writeViaQuickAdd("log_exercise", "EXERCISE", input);
  }

  async logBiometric(input: BiometricLogInput & { confirmed?: boolean }) {
    return this.writeViaQuickAdd("log_biometric", "BIOMETRIC", input);
  }

  async logNote(input: NoteLogInput & { confirmed?: boolean }) {
    return this.writeViaQuickAdd("log_note", "NOTE", input);
  }

  async listCustomFoods(input: CustomFoodListInput = {}) {
    return this.withPage("list_custom_foods", async (page) => {
      await this.openApp(page, "#custom-foods");
      const rawText = await waitForCustomItemListText(page, "Custom Foods", this.config.navigationTimeoutMs);
      const names = parseCustomItemListNames(rawText, "Custom Foods");
      const filteredNames = filterCustomItemNames(names, input.query);
      const includeDetails = input.includeDetails !== false;
      const maxDetails = Math.max(0, Math.min(input.maxDetails ?? 10, 25));
      const details = includeDetails ? await customFoodDetailsForNames(page, filteredNames, maxDetails) : [];
      return this.result("list_custom_foods", "ok", {
        query: input.query,
        count: filteredNames.length,
        names: filteredNames,
        foods: details,
        duplicateGroups: duplicateGroups(details.length ? details.map((food) => food.name) : filteredNames),
        rawText: compactText(rawText, 12000),
      });
    });
  }

  async findDuplicateCustomFoods(input: CustomFoodDuplicateInput) {
    return this.withPage("find_duplicate_custom_foods", async (page) => {
      await this.openApp(page, "#custom-foods");
      const rawText = await waitForCustomItemListText(page, "Custom Foods", this.config.navigationTimeoutMs);
      const names = filterCustomItemNames(parseCustomItemListNames(rawText, "Custom Foods"), input.name);
      const maxDetails = Math.max(1, Math.min(input.maxDetails ?? 15, 30));
      const matches = await customFoodDetailsForNames(page, names, maxDetails);
      return this.result("find_duplicate_custom_foods", "ok", {
        query: input.name,
        matchCount: matches.length,
        matches,
        duplicateGroups: duplicateGroups(matches.map((food) => food.name)),
        rawText: compactText(rawText, 6000),
      });
    });
  }

  async createCustomFood(input: CustomFoodInput & { confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    if (confirmedWrite) {
      const backgroundKey = backgroundBrowserJobKey("create_custom_food", {
        name: input.name,
        servingSize: input.servingSize,
        nutrients: input.nutrients,
        barcode: input.barcode,
        duplicatePolicy: input.duplicatePolicy ?? "update_existing",
      });
      const accepted = this.startBackgroundBrowserJob(
        "create_custom_food",
        backgroundKey,
        safeInput(input),
        () => this.runCreateCustomFood(input),
      );
      return this.waitForAcceptedBackgroundJob(
        "create_custom_food",
        accepted,
        input.waitForCompletionSeconds ?? DEFAULT_CUSTOM_WRITE_WAIT_SECONDS,
      );
    }
    return this.runCreateCustomFood(input);
  }

  private async runCreateCustomFood(input: CustomFoodInput & { confirmed?: boolean }) {
    const startedAt = Date.now();
    const trace: CustomFoodTraceEntry[] = [];
    const traceStep = (step: string, details?: Record<string, unknown>) => logCustomFoodStep(input.name, startedAt, step, details, trace);
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    const duplicatePolicy = input.duplicatePolicy ?? "update_existing";
    if (!confirmedWrite) {
      return this.result("create_custom_food", "dry_run", {
        input: safeInput(input),
        duplicatePolicy,
        preview: customFoodWritePreview(input),
        reason: writeGateReason(input, this.config.writeEnabled),
        nextStep: this.config.writeEnabled
          ? "Call again with confirmed=true. duplicatePolicy defaults to update_existing for exactly one same-named food, fails on multiple matches, and creates only when no match exists."
          : "Set CRONOMETER_ENABLE_WRITES=true to allow Cronometer custom food writes.",
      });
    }

    return this.withPage("create_custom_food", (page) =>
      this.createCustomFoodOnPage(page, input, duplicatePolicy, trace, traceStep)
    );
  }

  private async createCustomFoodOnPage(
    page: Page,
    input: CustomFoodInput & { confirmed?: boolean },
    duplicatePolicy: NonNullable<CustomFoodInput["duplicatePolicy"]>,
    trace: CustomFoodTraceEntry[],
    traceStep: (step: string, details?: Record<string, unknown>) => void,
  ): Promise<ProviderResult> {
    traceStep("open_custom_foods:start");
    await this.openApp(page, "#custom-foods");
    traceStep("open_custom_foods:done", { url: page.url() });
    const existing = duplicatePolicy === "create_new"
      ? { names: [], targets: [] as CustomFoodDetail[] }
      : await resolveCustomFoodTargets(page, { name: input.name }, {
          maxDetails: 12,
          timeoutMs: this.config.navigationTimeoutMs,
          lightweightExactName: true,
        });
    traceStep(duplicatePolicy === "create_new" ? "duplicates_skipped" : "duplicates_resolved", {
      existingCount: existing.targets.length,
      visibleNameCount: existing.names.length,
      duplicatePolicy,
    });
    if (existing.targets.length > 0 && duplicatePolicy === "fail") {
      return this.result("create_custom_food", "needs_manual_step", {
        input: safeInput(input),
        duplicatePolicy,
        existingFoods: existing.targets,
        duplicateGroups: duplicateGroups(existing.targets.map((food) => food.name)),
        trace,
        nextStep: "Use update_custom_food with foodId/name to edit an existing food, or call create_custom_food with duplicatePolicy=create_new if a duplicate is intentional.",
      }, "A custom food with this name already exists. Refusing to create a duplicate by default.");
    }

    const shouldUpdateExisting = existing.targets.length === 1 && duplicatePolicy === "update_existing";
    if (existing.targets.length > 1 && duplicatePolicy === "update_existing") {
      return this.result("create_custom_food", "needs_manual_step", {
        input: safeInput(input),
        duplicatePolicy,
        existingFoods: existing.targets,
        trace,
        nextStep: "More than one matching custom food exists. Call update_custom_food with a specific foodId.",
      }, "Cannot update existing because multiple matching custom foods were found.");
    }

    const openedExisting = shouldUpdateExisting ? await openCustomFoodTarget(page, existing.targets[0]) : false;
    const openedCreateForm = openedExisting || await clickByText(page, /^CREATE FOOD$/i);
    traceStep("editor_opened", { openedExisting, openedCreateForm });
    if (!openedCreateForm) {
      const visibleText = compactText(await this.visibleText(page), 10000);
      return this.result("create_custom_food", "needs_manual_step", { input: safeInput(input), trace, visibleText }, "Could not find an existing custom food or CREATE FOOD.");
    }

    await page.waitForTimeout(1200);
    const nameFilled = await fillCustomFoodName(page, input.name);
    const serving = await fillCustomFoodServing(page, input.servingSize);
    traceStep("basics_filled", { nameFilled, servingWarning: serving.warning });
    const nutrients = await fillCustomFoodNutrients(page, input.nutrients ?? {});
    traceStep("nutrients_filled", summarizeFillResults(nutrients));

    const saved = await clickByText(page, /^SAVE CHANGES$/i);
    traceStep("save_clicked", { saved });
    if (!saved) {
      return this.result(
        "create_custom_food",
        "needs_manual_step",
        {
          input: safeInput(input),
          nameFilled,
          serving,
          nutrients,
          trace,
          visibleText: compactText(await this.visibleText(page), 12000),
        },
        "Filled the custom food form but could not find Save Changes.",
      );
    }

    await page.waitForTimeout(900);
    const confirmationClicked = await clickOptionalSaveConfirmation(page);
    if (confirmationClicked) await page.waitForTimeout(1300);
    const afterSaveText = compactText(await this.visibleText(page).catch(() => ""), 12000);
    await page.waitForTimeout(900);
    await this.openApp(page, "#custom-foods");
    const listText = await this.visibleText(page);
    const listed = textHasFoodName(listText, input.name);
    traceStep("listed_checked", { listed, confirmationClicked });
    return this.result(
      "create_custom_food",
      listed ? "ok" : "needs_manual_step",
      {
        created: listed,
        updated: openedExisting,
        action: openedExisting ? "updated_existing" : "created_new",
        duplicatePolicy,
        foodName: input.name,
        nameFilled,
        serving,
        nutrients,
        confirmationClicked,
        afterSaveText,
        trace,
        visibleText: compactText(listText, 12000),
      },
      listed ? undefined : "Clicked Save Changes, but the custom food was not found in the Custom Foods list afterward.",
    );
  }

  async createAndLogCustomFood(input: CustomFoodAndLogInput & { confirmed?: boolean }) {
    const logInput: FoodLogInput = {
      date: input.date,
      meal: input.meal ?? "Snacks",
      query: input.name,
      selectedName: input.name,
      selectedSource: "Custom Food",
      amount: input.amount ?? 1,
      unit: input.unit,
      timestamp: input.timestamp,
      matchPolicy: "selected_only",
      searchScope: "custom",
      dryRun: input.dryRun,
      confirmed: input.confirmed,
    };
    const customFoodInput: CustomFoodInput & { confirmed?: boolean } = {
      name: input.name,
      servingSize: input.servingSize,
      nutrients: input.nutrients,
      barcode: input.barcode,
      duplicatePolicy: input.duplicatePolicy ?? "update_existing",
      dryRun: input.dryRun,
      confirmed: input.confirmed,
    };

    if (input.dryRun === true || !shouldRunConfirmedWrite(input, this.config.writeEnabled)) {
      const createPreview = await this.createCustomFood({ ...customFoodInput, dryRun: true, confirmed: false });
      const logPreview = await this.logFood({ ...logInput, dryRun: true, confirmed: false });
      return this.result("create_and_log_custom_food", "dry_run", {
        input: safeInput(input),
        nutritionSource: input.nutritionSource,
        createCustomFood: createPreview,
        logFood: logPreview,
        nextStep: this.config.writeEnabled
          ? "After verifying the researched nutrition facts and serving size, call again with confirmed=true and dryRun=false or omitted."
          : "Set CRONOMETER_ENABLE_WRITES=true to allow Cronometer writes.",
      });
    }

    const backgroundKey = backgroundBrowserJobKey("create_and_log_custom_food", {
      name: input.name,
      servingSize: input.servingSize,
      nutrients: input.nutrients,
      barcode: input.barcode,
      duplicatePolicy: customFoodInput.duplicatePolicy,
      date: logInput.date,
      meal: logInput.meal,
      amount: logInput.amount,
      unit: logInput.unit,
      timestamp: logInput.timestamp,
    });

    const accepted = this.startBackgroundBrowserJob(
      "create_and_log_custom_food",
      backgroundKey,
      safeInput(input),
      () => this.runCreateAndLogCustomFood(input, logInput, customFoodInput),
    );
    return this.waitForAcceptedBackgroundJob(
      "create_and_log_custom_food",
      accepted,
      input.waitForCompletionSeconds ?? DEFAULT_CUSTOM_WRITE_WAIT_SECONDS,
    );
  }

  private async runCreateAndLogCustomFood(
    input: CustomFoodAndLogInput & { confirmed?: boolean },
    logInput: FoodLogInput,
    customFoodInput: CustomFoodInput & { confirmed?: boolean },
  ): Promise<ProviderResult> {
    const normalizedLog = normalizeFoodLogInput(logInput, this.config.timeZone);
    const logPreflightData = foodLogBrowserPreflightData(normalizedLog);
    const startedAt = Date.now();
    const trace: CustomFoodTraceEntry[] = [];
    const traceStep = (step: string, details?: Record<string, unknown>) => logCustomFoodStep(input.name, startedAt, step, details, trace);
    return this.withPage("create_and_log_custom_food", async (page) => {
      const created = await this.createCustomFoodOnPage(page, customFoodInput, customFoodInput.duplicatePolicy ?? "update_existing", trace, traceStep);
      if (!["ok", "already_exists"].includes(created.status)) {
        return this.result("create_and_log_custom_food", created.status, {
          input: safeInput(input),
          nutritionSource: input.nutritionSource,
          createCustomFood: created,
          logFood: {
            skipped: true,
            reason: "Custom food creation/update did not complete cleanly, so no diary log was attempted.",
          },
          elapsedMs: Date.now() - startedAt,
        }, created.warning ?? "Custom food creation/update did not complete cleanly. No diary log was attempted.", created.source);
      }

      const logged = await this.logFoodOnPage(page, logInput, normalizedLog, logPreflightData);
      const status = logged.status === "written" || logged.status === "already_exists" ? logged.status : logged.status;
      return this.result("create_and_log_custom_food", status, {
        input: safeInput(input),
        nutritionSource: input.nutritionSource,
        createCustomFood: created,
        logFood: logged,
        completed: ["written", "already_exists"].includes(logged.status),
        customFoodName: input.name,
        meal: logInput.meal,
        date: logInput.date,
        elapsedMs: Date.now() - startedAt,
      }, logged.warning, logged.source);
    });
  }

  async updateCustomFood(input: CustomFoodUpdateInput & { confirmed?: boolean }) {
    if (shouldRunConfirmedWrite(input, this.config.writeEnabled)) {
      const backgroundKey = backgroundBrowserJobKey("update_custom_food", {
        foodId: input.foodId,
        name: input.name,
        newName: input.newName,
        servingSize: input.servingSize,
        nutrients: input.nutrients,
      });
      const accepted = this.startBackgroundBrowserJob(
        "update_custom_food",
        backgroundKey,
        safeInput(input),
        () => this.runUpdateCustomFood(input),
      );
      return this.waitForAcceptedBackgroundJob(
        "update_custom_food",
        accepted,
        input.waitForCompletionSeconds ?? DEFAULT_CUSTOM_WRITE_WAIT_SECONDS,
      );
    }
    return this.runUpdateCustomFood(input);
  }

  private async runUpdateCustomFood(input: CustomFoodUpdateInput & { confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    return this.withPage("update_custom_food", async (page) => {
      await this.openApp(page, "#custom-foods");
      const resolved = await resolveCustomFoodTargets(page, input, { maxDetails: 20, timeoutMs: this.config.navigationTimeoutMs });
      if (resolved.targets.length !== 1) {
        return this.result("update_custom_food", "needs_manual_step", {
          input: safeInput(input),
          visibleNames: resolved.names,
          candidates: resolved.targets,
          candidateCount: resolved.targets.length,
          nextStep: resolved.targets.length > 1 ? "Call update_custom_food again with the exact foodId." : "No matching custom food was found.",
        }, resolved.targets.length > 1 ? "Multiple matching custom foods were found; update requires an exact target." : "No matching custom food was found.");
      }

      const before = resolved.targets[0];
      const after = {
        foodId: before.foodId,
        name: input.newName ?? before.name,
        servingSize: input.servingSize ?? before.servingSize,
        nutrients: input.nutrients,
      };
      if (!confirmedWrite) {
        return this.result("update_custom_food", "dry_run", {
          input: safeInput(input),
          before,
          after,
          preview: customFoodWritePreview(input),
          reason: writeGateReason(input, this.config.writeEnabled),
          nextStep: "Review the before/after diff, then call with confirmed=true to update this exact custom food.",
        });
      }

      const opened = await openCustomFoodTarget(page, before);
      if (!opened) {
        return this.result("update_custom_food", "needs_manual_step", { input: safeInput(input), before }, "Could not reopen the selected custom food.");
      }

      const nameFilled = input.newName ? await fillCustomFoodName(page, input.newName) : true;
      const serving = input.servingSize ? await fillCustomFoodServing(page, input.servingSize) : undefined;
      const nutrients = input.nutrients ? await fillCustomFoodNutrients(page, input.nutrients) : [];
      const saved = await clickByText(page, /^SAVE CHANGES$/i);
      if (!saved) {
        return this.result("update_custom_food", "needs_manual_step", {
          input: safeInput(input),
          before,
          nameFilled,
          serving,
          nutrients,
          visibleText: compactText(await this.visibleText(page), 12000),
        }, "Filled the custom food editor but could not find Save Changes.");
      }

      await page.waitForTimeout(1200);
      const confirmationClicked = await clickOptionalSaveConfirmation(page);
      if (confirmationClicked) await page.waitForTimeout(1300);
      const afterSaveText = compactText(await this.visibleText(page).catch(() => ""), 12000);
      const finalDetail = await extractCustomFoodDetail(page);
      return this.result("update_custom_food", "ok", {
        updated: true,
        action: "updated_existing",
        before,
        after: finalDetail ?? after,
        nameFilled,
        serving,
        nutrients,
        confirmationClicked,
        afterSaveText,
      });
    });
  }

  async deleteCustomFood(input: CustomFoodDeleteInput & { confirmed?: boolean }) {
    if (shouldRunConfirmedWrite(input, this.config.writeEnabled)) {
      const backgroundKey = backgroundBrowserJobKey("delete_custom_food", {
        foodId: input.foodId,
        name: input.name,
        confirmName: input.confirmName,
        ifUsed: input.ifUsed ?? "stop",
      });
      const accepted = this.startBackgroundBrowserJob(
        "delete_custom_food",
        backgroundKey,
        safeInput(input),
        () => this.runDeleteCustomFood(input),
      );
      return this.waitForAcceptedBackgroundJob(
        "delete_custom_food",
        accepted,
        input.waitForCompletionSeconds ?? DEFAULT_CUSTOM_WRITE_WAIT_SECONDS,
      );
    }
    return this.runDeleteCustomFood(input);
  }

  private async runDeleteCustomFood(input: CustomFoodDeleteInput & { confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    const ifUsed = input.ifUsed ?? "stop";
    return this.withPage("delete_custom_food", async (page) => {
      await this.openApp(page, "#custom-foods");
      const resolved = await resolveCustomFoodTargets(page, input, { maxDetails: 25, timeoutMs: this.config.navigationTimeoutMs });
      if (resolved.targets.length !== 1) {
        return this.result("delete_custom_food", "needs_manual_step", {
          input: safeInput(input),
          visibleNames: resolved.names,
          candidates: resolved.targets,
          candidateCount: resolved.targets.length,
          nextStep: resolved.targets.length > 1 ? "Call delete_custom_food again with the exact foodId and confirmName." : "No matching custom food was found.",
        }, resolved.targets.length > 1 ? "Multiple matching custom foods were found; delete requires an exact target." : "No matching custom food was found.");
      }

      const target = resolved.targets[0];
      if (input.confirmName !== target.name) {
        return this.result("delete_custom_food", "dry_run", {
          input: safeInput(input),
          target,
          requiredConfirmName: target.name,
          nextStep: "Call delete_custom_food with confirmed=true and confirmName exactly matching the target name.",
        }, "Deletion requires confirmName to match the selected custom food name.");
      }

      if (!confirmedWrite) {
        return this.result("delete_custom_food", "dry_run", {
          input: safeInput(input),
          target,
          reason: writeGateReason(input, this.config.writeEnabled),
          ifUsed,
          nextStep: "Review the target food, then call with confirmed=true and the same confirmName to delete it. If old diary entries may depend on it, use retire_custom_food or ifUsed='retire'.",
        });
      }

      const opened = await openCustomFoodTarget(page, target);
      if (!opened) {
        return this.result("delete_custom_food", "needs_manual_step", { input: safeInput(input), target }, "Could not reopen the selected custom food.");
      }
      const menuClicked = await clickByText(page, /^more_horiz$/i) || await clickByText(page, /^(MORE|ACTIONS)$/i);
      if (!menuClicked) {
        return this.result("delete_custom_food", "needs_manual_step", {
          input: safeInput(input),
          target,
          visibleText: compactText(await this.visibleText(page), 12000),
        }, "Could not find the custom food actions menu.");
      }
      await page.waitForTimeout(500);
      const deleteClicked = await clickByText(page, /^(DELETE|DELETE FOOD|DELETE \/ RETIRE FOOD(?:\.\.\.)?|REMOVE)$/i);
      if (!deleteClicked) {
        return this.result("delete_custom_food", "needs_manual_step", {
          input: safeInput(input),
          target,
          visibleText: compactText(await this.visibleText(page), 12000),
        }, "Opened the actions menu but could not find a delete action.");
      }
      await page.waitForTimeout(500);
      const confirmation = await handleOptionalDeleteConfirmation(page, target.name, ifUsed);
      if (confirmation.blocked) {
        return this.result("delete_custom_food", "needs_manual_step", {
          input: safeInput(input),
          target,
          deleteConfirmation: confirmation,
          nextStep: "Cronometer warned that this food may be used by existing entries. Use retire_custom_food, or call delete_custom_food with ifUsed='force' only after explicit approval.",
        }, "Cronometer showed a dependency warning, so deletion was stopped.");
      }

      if (confirmation.retireInstead) {
        const retiredName = retiredItemName(input.name ?? target.name, input.foodId);
        const retired = await retireOpenCustomFood(page, target, retiredName);
        return this.result(retired.saved ? "delete_custom_food" : "delete_custom_food", retired.saved ? "ok" : "needs_manual_step", {
          deleted: false,
          action: "retired_instead",
          target,
          retiredName,
          deleteConfirmation: confirmation,
          retired,
        }, retired.saved ? "Cronometer warned about existing references, so the custom food was retired instead of deleted." : "Cronometer warned about existing references, and the retire fallback could not be saved.");
      }

      await page.waitForTimeout(1200);
      await this.openApp(page, "#custom-foods");
      const listText = await waitForCustomItemListText(page, "Custom Foods", this.config.navigationTimeoutMs);
      const stillListed = textHasFoodName(listText, target.name);
      return this.result("delete_custom_food", stillListed ? "needs_manual_step" : "ok", {
        deleted: !stillListed,
        target,
        confirmation,
        visibleText: compactText(listText, 8000),
      }, stillListed ? "Delete was clicked, but the food name still appeared in the Custom Foods list afterward." : undefined);
    });
  }

  async retireCustomFood(input: CustomFoodRetireInput & { confirmed?: boolean }) {
    if (shouldRunConfirmedWrite(input, this.config.writeEnabled)) {
      const backgroundKey = backgroundBrowserJobKey("retire_custom_food", {
        foodId: input.foodId,
        name: input.name,
        retiredName: input.retiredName,
      });
      const accepted = this.startBackgroundBrowserJob(
        "retire_custom_food",
        backgroundKey,
        safeInput(input),
        () => this.runRetireCustomFood(input),
      );
      return this.waitForAcceptedBackgroundJob(
        "retire_custom_food",
        accepted,
        input.waitForCompletionSeconds ?? DEFAULT_CUSTOM_WRITE_WAIT_SECONDS,
      );
    }
    return this.runRetireCustomFood(input);
  }

  private async runRetireCustomFood(input: CustomFoodRetireInput & { confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    return this.withPage("retire_custom_food", async (page) => {
      await this.openApp(page, "#custom-foods");
      const resolved = await resolveCustomFoodTargets(page, input, { maxDetails: 25, timeoutMs: this.config.navigationTimeoutMs });
      if (resolved.targets.length !== 1) {
        return this.result("retire_custom_food", "needs_manual_step", {
          input: safeInput(input),
          visibleNames: resolved.names,
          candidates: resolved.targets,
          candidateCount: resolved.targets.length,
          nextStep: resolved.targets.length > 1 ? "Call retire_custom_food again with the exact foodId." : "No matching custom food was found.",
        }, resolved.targets.length > 1 ? "Multiple matching custom foods were found; retire requires an exact target." : "No matching custom food was found.");
      }

      const target = resolved.targets[0];
      const retiredName = input.retiredName ?? retiredItemName(target.name, target.foodId);
      if (!confirmedWrite) {
        return this.result("retire_custom_food", "dry_run", {
          input: safeInput(input),
          target,
          retiredName,
          reason: writeGateReason(input, this.config.writeEnabled),
          nextStep: "Review the exact target and retiredName, then call with confirmed=true to rename instead of delete.",
        });
      }

      const opened = await openCustomFoodTarget(page, target);
      if (!opened) {
        return this.result("retire_custom_food", "needs_manual_step", { input: safeInput(input), target }, "Could not reopen the selected custom food.");
      }
      const retired = await retireOpenCustomFood(page, target, retiredName);
      return this.result("retire_custom_food", retired.saved ? "ok" : "needs_manual_step", {
        action: "retired",
        target,
        retiredName,
        retired,
      }, retired.saved ? undefined : "The custom food editor opened, but the retired name could not be saved.");
    });
  }

  async listCustomRecipes(input: CustomFoodListInput = {}) {
    return this.withPage("list_custom_recipes", async (page) => {
      await this.openApp(page, "#custom-recipes");
      const rawText = await waitForCustomItemListText(page, "Custom Recipes", this.config.navigationTimeoutMs);
      const names = filterCustomItemNames(parseCustomItemListNames(rawText, "Custom Recipes"), input.query);
      const includeDetails = input.includeDetails === true;
      const maxDetails = Math.max(0, Math.min(input.maxDetails ?? 10, 25));
      const details = includeDetails ? await customRecipeDetailsForNames(page, names, maxDetails) : [];
      return this.result("list_custom_recipes", "ok", {
        query: input.query,
        count: names.length,
        names,
        recipes: details.length ? details : names.map((name) => ({ name })),
        duplicateGroups: duplicateGroups(details.length ? details.map((recipe) => recipe.name) : names),
        rawText: compactText(rawText, 12000),
      });
    });
  }

  async createRecipe(input: RecipeInput & { confirmed?: boolean }) {
    const preview = {
      recipeName: input.name,
      servings: input.servings,
      servingName: input.servingName,
      cookedWeight: input.cookedWeight,
      cookedWeightUnit: input.cookedWeightUnit,
      ingredients: input.ingredients,
    };

    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    if (!confirmedWrite) {
      return this.result("create_recipe", "dry_run", {
        input: safeInput(input),
        preview,
        reason: writeGateReason(input, this.config.writeEnabled),
        nextStep: this.config.writeEnabled
          ? "Call again with confirmed=true after reviewing exact Cronometer ingredient matches. Leave dryRun unset, or set dryRun=false."
          : "Set CRONOMETER_ENABLE_WRITES=true to allow Cronometer recipe writes.",
      });
    }

    return this.withPage("create_recipe", async (page) => {
      const startedAt = Date.now();
      const traceEntries: RecipeTraceEntry[] = [];
      const trace: RecipeTrace = (step, details) => logRecipeStep(input.name, startedAt, step, details, traceEntries);
      const deadline = Date.now() + Math.max(30000, Math.min(this.config.operationTimeoutMs - 15000, 900000));
      trace("open_app_start", { ingredientCount: input.ingredients.length });
      await this.openApp(page, "#custom-recipes");
      trace("open_app_done");
      trace("create_button_click_start");
      const opened = await clickByText(page, /^CREATE RECIPE$/i);
      trace("create_button_click_done", { opened });
      if (!opened) {
        return this.result("create_recipe", "needs_manual_step", { input: safeInput(input) }, "Could not find CREATE RECIPE.");
      }

      await page.waitForTimeout(450);
      trace("fill_basics_start");
      const basics = await fillRecipeBasics(page, input);
      trace("fill_basics_done", basics);

      const addedIngredients = [];
      for (const [index, ingredient] of input.ingredients.entries()) {
        if (Date.now() > deadline - 4500) {
          trace("ingredient_budget_exhausted", { ingredientIndex: index });
          return this.result("create_recipe", "needs_manual_step", {
            recipeName: input.name,
            basics,
            addedIngredients,
            stoppedBeforeIngredient: { index, ingredient },
            trace: traceEntries.slice(-40),
            visibleText: compactText(await this.visibleText(page).catch(() => ""), 10000),
          }, "Stopped before the hosted operation budget expired. Retry with the remaining ingredients or use fewer ingredients per call.");
        }
        trace("ingredient_start", { ingredientIndex: index });
        const ingredientBudgetMs = Math.min(28000, Math.max(9000, deadline - Date.now() - 7000));
        const added = await withTimeout(
          addRecipeIngredient(page, ingredient, {
            deadline: Math.min(deadline, Date.now() + ingredientBudgetMs),
            trace: (step, details) => trace(step, { ingredientIndex: index, ...details }),
          }),
          ingredientBudgetMs,
          `Timed out adding recipe ingredient ${index + 1} (${ingredient.query}) after ${ingredientBudgetMs}ms.`,
        ).catch(async (error) => ({
          status: "ingredient_timeout",
          warning: error instanceof Error ? error.message : String(error),
          editorDebug: await recipeIngredientEditorDebug(page),
          visibleText: compactText(await this.visibleText(page).catch(() => ""), 8000),
        }));
        trace("ingredient_done", { ingredientIndex: index, status: added.status });
        addedIngredients.push({ ingredient, ...added });
        if (added.status !== "ok") break;
      }

      const allAdded = addedIngredients.every((item) => item.status === "ok");
      trace("refill_basics_start", { allAdded });
      const refilledBasics = allAdded ? await fillRecipeBasics(page, input) : undefined;
      trace("refill_basics_done", refilledBasics);
      trace("read_visible_text_start");
      const visibleText = await this.visibleText(page);
      const nameVisible = visibleText.toLowerCase().includes(input.name.toLowerCase());
      trace("read_visible_text_done", { allAdded, nameVisible });
      const saveClicked = allAdded && nameVisible
        ? (trace("save_click_start"), await clickByText(page, /^SAVE CHANGES$/i) || await clickByText(page, /^SAVE$/i))
        : false;
      trace("save_click_done", { saveClicked });
      let postSaveText = "";
      let finalDetail: CustomRecipeDetail | undefined;
      let listVerified = false;
      if (saveClicked) {
        trace("post_save_wait_start");
        await page.waitForTimeout(1200);
        await clickOptionalSaveConfirmation(page).catch(() => false);
        await page.waitForTimeout(1000);
        trace("extract_final_detail_start");
        finalDetail = await extractCustomRecipeDetail(page).catch(() => undefined);
        postSaveText = await this.visibleText(page).catch(() => "");
        trace("extract_final_detail_done", { finalDetailName: finalDetail?.name, hasPostSaveText: Boolean(postSaveText) });
        trace("list_verify_start");
        listVerified = await customRecipeExistsInList(page, input.name, this.config.navigationTimeoutMs).catch(() => false);
        trace("list_verify_done", { listVerified });
      }

      const editorVerified = Boolean(finalDetail?.name.toLowerCase() === input.name.toLowerCase() || textHasFoodName(postSaveText, input.name));
      const servingsVerified = recipeServingsVerified(finalDetail, input);
      const ingredientsVerified = recipeIngredientsVerified(finalDetail, addedIngredients);
      const ok = allAdded && nameVisible && saveClicked && editorVerified && listVerified && servingsVerified && ingredientsVerified;
      trace("result", { ok, allAdded, nameVisible, saveClicked, editorVerified, listVerified, servingsVerified, ingredientsVerified });
      return this.result("create_recipe", ok ? "ok" : "needs_manual_step", {
        recipeName: input.name,
        basics,
        refilledBasics,
        addedIngredients,
        saveClicked,
        editorVerified,
        listVerified,
        servingsVerified,
        ingredientsVerified,
        finalDetail,
        trace: traceEntries.slice(-60),
        postSaveText: postSaveText ? compactText(postSaveText, 8000) : undefined,
        visibleText: compactText(visibleText, 12000),
      }, ok ? undefined : "Recipe editor opened, but the saved recipe could not be fully verified after clicking Save.");
    });
  }

  async updateCustomRecipe(input: RecipeUpdateInput & { confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    return this.withPage("update_custom_recipe", async (page) => {
      await this.openApp(page, "#custom-recipes");
      const resolved = await resolveCustomRecipeTargets(page, input, { maxDetails: 20, timeoutMs: this.config.navigationTimeoutMs });
      if (resolved.targets.length !== 1) {
        return this.result("update_custom_recipe", "needs_manual_step", {
          input: safeInput(input),
          visibleNames: resolved.names,
          candidates: resolved.targets,
          candidateCount: resolved.targets.length,
          nextStep: resolved.targets.length > 1 ? "Call update_custom_recipe again with the exact recipeId." : "No matching custom recipe was found.",
        }, resolved.targets.length > 1 ? "Multiple matching custom recipes were found; update requires an exact target." : "No matching custom recipe was found.");
      }

      const before = resolved.targets[0];
      const basicsInput: RecipeInput = {
        name: input.newName ?? before.name,
        ingredients: input.ingredientsToAdd ?? [],
        servings: input.servings,
        servingName: input.servingName,
        cookedWeight: input.cookedWeight,
        cookedWeightUnit: input.cookedWeightUnit,
      };
      const after = {
        recipeId: before.recipeId,
        name: basicsInput.name,
        servings: input.servings,
        servingName: input.servingName,
        cookedWeight: input.cookedWeight,
        cookedWeightUnit: input.cookedWeightUnit,
        ingredientsToAdd: input.ingredientsToAdd,
      };
      if (!confirmedWrite) {
        return this.result("update_custom_recipe", "dry_run", {
          input: safeInput(input),
          before,
          after,
          reason: writeGateReason(input, this.config.writeEnabled),
          nextStep: "Review the before/after diff, then call with confirmed=true to update this exact custom recipe.",
        });
      }

      const opened = await openCustomRecipeTarget(page, before);
      if (!opened) {
        return this.result("update_custom_recipe", "needs_manual_step", { input: safeInput(input), before }, "Could not reopen the selected custom recipe.");
      }
      const basics = await fillRecipeBasics(page, basicsInput);
      const addedIngredients = [];
      for (const ingredient of input.ingredientsToAdd ?? []) {
        const added = await addRecipeIngredient(page, ingredient);
        addedIngredients.push({ ingredient, ...added });
      }
      const saveClicked = await clickByText(page, /^SAVE CHANGES$/i) || await clickByText(page, /^SAVE$/i);
      await page.waitForTimeout(1000);
      const finalDetail = await extractCustomRecipeDetail(page);
      const allAdded = addedIngredients.every((item) => item.status === "ok");
      return this.result("update_custom_recipe", allAdded ? "ok" : "needs_manual_step", {
        updated: allAdded,
        action: "updated_existing",
        before,
        after: finalDetail ?? after,
        basics,
        addedIngredients,
        saveClicked,
        visibleText: compactText(await this.visibleText(page), 12000),
      }, allAdded ? undefined : "Recipe editor opened, but one or more added ingredients could not be verified.");
    });
  }

  async deleteCustomRecipe(input: RecipeDeleteInput & { confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    const ifUsed = input.ifUsed ?? "stop";
    return this.withPage("delete_custom_recipe", async (page) => {
      await this.openApp(page, "#custom-recipes");
      const resolved = await resolveCustomRecipeTargets(page, input, { maxDetails: 25, timeoutMs: this.config.navigationTimeoutMs });
      if (resolved.targets.length !== 1) {
        return this.result("delete_custom_recipe", "needs_manual_step", {
          input: safeInput(input),
          visibleNames: resolved.names,
          candidates: resolved.targets,
          candidateCount: resolved.targets.length,
          nextStep: resolved.targets.length > 1 ? "Call delete_custom_recipe again with the exact recipeId and confirmName." : "No matching custom recipe was found.",
        }, resolved.targets.length > 1 ? "Multiple matching custom recipes were found; delete requires an exact target." : "No matching custom recipe was found.");
      }

      const target = resolved.targets[0];
      if (input.confirmName !== target.name) {
        return this.result("delete_custom_recipe", "dry_run", {
          input: safeInput(input),
          target,
          requiredConfirmName: target.name,
          nextStep: "Call delete_custom_recipe with confirmed=true and confirmName exactly matching the target recipe name.",
        }, "Deletion requires confirmName to match the selected custom recipe name.");
      }

      if (!confirmedWrite) {
        return this.result("delete_custom_recipe", "dry_run", {
          input: safeInput(input),
          target,
          reason: writeGateReason(input, this.config.writeEnabled),
          ifUsed,
          nextStep: "Review the target recipe, then call with confirmed=true and the same confirmName to delete it. If old diary entries may depend on it, use retire_custom_recipe or ifUsed='retire'.",
        });
      }

      const opened = await openCustomRecipeTarget(page, target);
      if (!opened) {
        return this.result("delete_custom_recipe", "needs_manual_step", { input: safeInput(input), target }, "Could not reopen the selected custom recipe.");
      }
      const menuClicked = await clickByText(page, /^more_horiz$/i) || await clickByText(page, /^(MORE|ACTIONS)$/i);
      if (!menuClicked) {
        return this.result("delete_custom_recipe", "needs_manual_step", {
          input: safeInput(input),
          target,
          visibleText: compactText(await this.visibleText(page), 12000),
        }, "Could not find the custom recipe actions menu.");
      }
      await page.waitForTimeout(500);
      const deleteClicked = await clickByText(page, /^(DELETE|DELETE RECIPE|DELETE \/ RETIRE RECIPE(?:\.\.\.)?|REMOVE)$/i);
      if (!deleteClicked) {
        return this.result("delete_custom_recipe", "needs_manual_step", {
          input: safeInput(input),
          target,
          visibleText: compactText(await this.visibleText(page), 12000),
        }, "Opened the actions menu but could not find a delete action.");
      }
      await page.waitForTimeout(500);
      const confirmation = await handleOptionalDeleteConfirmation(page, target.name, ifUsed);
      if (confirmation.blocked) {
        return this.result("delete_custom_recipe", "needs_manual_step", {
          input: safeInput(input),
          target,
          deleteConfirmation: confirmation,
          nextStep: "Cronometer warned that this recipe may be used by existing entries. Use retire_custom_recipe, or call delete_custom_recipe with ifUsed='force' only after explicit approval.",
        }, "Cronometer showed a dependency warning, so deletion was stopped.");
      }

      if (confirmation.retireInstead) {
        const retiredName = retiredItemName(input.name ?? target.name, input.recipeId);
        const retired = await retireOpenCustomRecipe(page, target, retiredName);
        return this.result("delete_custom_recipe", retired.saved ? "ok" : "needs_manual_step", {
          deleted: false,
          action: "retired_instead",
          target,
          retiredName,
          deleteConfirmation: confirmation,
          retired,
        }, retired.saved ? "Cronometer warned about existing references, so the custom recipe was retired instead of deleted." : "Cronometer warned about existing references, and the retire fallback could not be saved.");
      }

      await page.waitForTimeout(1200);
      await this.openApp(page, "#custom-recipes");
      const listText = await waitForCustomItemListText(page, "Custom Recipes", this.config.navigationTimeoutMs);
      const stillListed = textHasFoodName(listText, target.name);
      return this.result("delete_custom_recipe", stillListed ? "needs_manual_step" : "ok", {
        deleted: !stillListed,
        target,
        confirmation,
        visibleText: compactText(listText, 8000),
      }, stillListed ? "Delete was clicked, but the recipe name still appeared in the Custom Recipes list afterward." : undefined);
    });
  }

  async retireCustomRecipe(input: RecipeRetireInput & { confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    return this.withPage("retire_custom_recipe", async (page) => {
      await this.openApp(page, "#custom-recipes");
      const resolved = await resolveCustomRecipeTargets(page, input, { maxDetails: 25, timeoutMs: this.config.navigationTimeoutMs });
      if (resolved.targets.length !== 1) {
        return this.result("retire_custom_recipe", "needs_manual_step", {
          input: safeInput(input),
          visibleNames: resolved.names,
          candidates: resolved.targets,
          candidateCount: resolved.targets.length,
          nextStep: resolved.targets.length > 1 ? "Call retire_custom_recipe again with the exact recipeId." : "No matching custom recipe was found.",
        }, resolved.targets.length > 1 ? "Multiple matching custom recipes were found; retire requires an exact target." : "No matching custom recipe was found.");
      }

      const target = resolved.targets[0];
      const retiredName = input.retiredName ?? retiredItemName(target.name, target.recipeId);
      if (!confirmedWrite) {
        return this.result("retire_custom_recipe", "dry_run", {
          input: safeInput(input),
          target,
          retiredName,
          reason: writeGateReason(input, this.config.writeEnabled),
          nextStep: "Review the exact target and retiredName, then call with confirmed=true to rename instead of delete.",
        });
      }

      const opened = await openCustomRecipeTarget(page, target);
      if (!opened) {
        return this.result("retire_custom_recipe", "needs_manual_step", { input: safeInput(input), target }, "Could not reopen the selected custom recipe.");
      }
      const retired = await retireOpenCustomRecipe(page, target, retiredName);
      return this.result("retire_custom_recipe", retired.saved ? "ok" : "needs_manual_step", {
        action: "retired",
        target,
        retiredName,
        retired,
      }, retired.saved ? undefined : "The custom recipe editor opened, but the retired name could not be saved.");
    });
  }

  async getTargets(input: DateRangeInput) {
    return this.readPage("get_targets", "#profile", input);
  }

  async setTargets(input: TargetsInput & { confirmed?: boolean }) {
    return this.confirmedPageWrite("set_targets", "#profile", input, "Targets + Profile writes need verified field selectors.");
  }

  async exportData(input: ExportDataInput & { confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    if (!confirmedWrite) {
      return this.result("export_data", "dry_run", {
        input: safeInput(input),
        reason: writeGateReason(input, this.config.writeEnabled),
        nextStep: this.config.writeEnabled
          ? "Call with confirmed=true to click EXPORT DATA. Leave dryRun unset, or set dryRun=false."
          : "Set CRONOMETER_ENABLE_WRITES=true to allow Cronometer export clicks.",
      });
    }

    return this.withPage("export_data", async (page) => {
      await this.openApp(page, "#account");
      const clicked = await clickByText(page, /^EXPORT DATA$/i);
      return this.result(clicked ? "export_data" : "export_data", clicked ? "ok" : "needs_manual_step", {
        clicked,
        visibleText: compactText(await this.visibleText(page), 10000),
      }, clicked ? undefined : "Could not find the EXPORT DATA button.");
    });
  }

  async startFast(input: FastInput & { confirmed?: boolean }) {
    return this.confirmedPageWrite("start_fast", "#fasting", input, "Fasting writes need verified selectors.");
  }

  async stopFast(input: FastInput & { confirmed?: boolean }) {
    return this.confirmedPageWrite("stop_fast", "#fasting", input, "Fasting writes need verified selectors.");
  }

  async scheduleRepeatItem(input: RepeatItemInput & { confirmed?: boolean }) {
    return this.confirmedPageWrite("schedule_repeat_item", "#repeat-items", input, "Repeat Item writes need verified selectors.");
  }

  private async readDiarySection(feature: string, input: DateRangeInput, hints: string[]) {
    return this.withPage(feature, async (page) => {
      const dateStatus = await this.openDiary(page, input.date);
      const rawText = await this.waitForDiaryText(page);
      return this.result(feature, dateStatus.selected ? "ok" : "needs_manual_step", {
        date: dateStatus.appliedDate,
        dateStatus,
        hints,
        rawText: compactText(rawText, 14000),
      }, dateStatus.warning);
    });
  }

  private async readPage(feature: string, hash: string, input: unknown) {
    return this.withPage(feature, async (page) => {
      await this.openApp(page, hash);
      return this.result(feature, "ok", {
        input: safeInput(input),
        hash,
        rawText: compactText(await this.visibleText(page), 14000),
      });
    });
  }

  private async createCustomItem(feature: string, hash: string, createButtonText: string, input: { name: string; dryRun?: boolean; confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    if (!confirmedWrite) {
      return this.result(feature, "dry_run", {
        input: safeInput(input),
        reason: writeGateReason(input, this.config.writeEnabled),
        nextStep: this.config.writeEnabled
          ? `Call again with confirmed=true to open ${createButtonText}. Leave dryRun unset, or set dryRun=false.`
          : `Set CRONOMETER_ENABLE_WRITES=true to allow Cronometer ${createButtonText.toLowerCase()} writes.`,
      });
    }

    return this.withPage(feature, async (page) => {
      await this.openApp(page, hash);
      const visibleText = compactText(await this.visibleText(page), 10000);

      const created = await clickByText(page, new RegExp(`^${escapeRegExp(createButtonText)}$`, "i"));
      if (!created) {
        return this.result(feature, "needs_manual_step", { input: safeInput(input), visibleText }, `Could not find ${createButtonText}.`);
      }

      await page.waitForTimeout(1000);
      await fillLikelyName(page, input.name);

      return this.result(
        feature,
        "needs_manual_step",
        {
          input: safeInput(input),
          visibleText: compactText(await this.visibleText(page), 10000),
        },
        "Opened the create flow and filled the name when possible. Ingredient/nutrient fields need selector verification before auto-saving.",
      );
    });
  }

  private async writeViaQuickAdd(feature: string, buttonText: string, input: { dryRun?: boolean; confirmed?: boolean }) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    if (!confirmedWrite) {
      return this.result(feature, "dry_run", {
        input: safeInput(input),
        reason: writeGateReason(input, this.config.writeEnabled),
        nextStep: this.config.writeEnabled
          ? `Call again with confirmed=true to open ${buttonText}. Leave dryRun unset, or set dryRun=false.`
          : `Set CRONOMETER_ENABLE_WRITES=true to allow Cronometer ${buttonText.toLowerCase()} writes.`,
      });
    }

    return this.withPage(feature, async (page) => {
      await this.openApp(page, "#diary");

      const clicked = await clickByText(page, new RegExp(`^${escapeRegExp(buttonText)}$`, "i"));
      if (!clicked) {
        return this.result(feature, "needs_manual_step", { input: safeInput(input) }, `Could not find ${buttonText}.`);
      }

      return this.result(
        feature,
        "needs_manual_step",
        {
          input: safeInput(input),
          visibleText: compactText(await this.visibleText(page), 10000),
        },
        "Opened the quick-add flow. Field selectors must be verified before auto-saving this entry type.",
      );
    });
  }

  private async confirmedPageWrite(feature: string, hash: string, input: { dryRun?: boolean; confirmed?: boolean }, warning: string) {
    const confirmedWrite = shouldRunConfirmedWrite(input, this.config.writeEnabled);
    if (!confirmedWrite) {
      return this.result(feature, "dry_run", {
        input: safeInput(input),
        hash,
        reason: writeGateReason(input, this.config.writeEnabled),
        nextStep: this.config.writeEnabled
          ? "Call again with confirmed=true after reviewing the requested change. Leave dryRun unset, or set dryRun=false."
          : "Set CRONOMETER_ENABLE_WRITES=true to allow this Cronometer write.",
      }, warning);
    }

    return this.withPage(feature, async (page) => {
      await this.openApp(page, hash);
      return this.result(feature, "needs_manual_step", {
        input: safeInput(input),
        hash,
        visibleText: compactText(await this.visibleText(page), 10000),
      }, warning);
    });
  }

  private async searchFoodUi(
    page: Page,
    query: string,
    limit: number,
    date?: string,
    options: { searchScope?: FoodLogInput["searchScope"]; selectedSource?: string } = {},
  ): Promise<FoodSearchOutcome> {
    const dateStatus = await this.openFoodSearchDialog(page, date);
    if (date && !dateStatus.selected) return { results: [], dateStatus };

    const attempts = foodSearchTabAttempts(options.searchScope, options.selectedSource);
    let fallbackTab: string | undefined;
    let fallbackResults: SearchResult[] = [];

    for (const tab of attempts) {
      if (tab && !(await clickFoodDialogFilter(page, tab))) continue;

      const results = await searchCurrentFoodDialog(page, query, limit);
      if (results.length === 0) continue;

      if (!fallbackResults.length || tab === "Custom") {
        fallbackTab = tab;
        fallbackResults = results;
      }

      if (hasExactFoodResult(query, results)) {
        return { results, dateStatus };
      }
    }

    if (fallbackResults.length > 0) {
      if (fallbackTab) {
        await clickFoodDialogFilter(page, fallbackTab);
      } else {
        await clickFoodDialogFilter(page, "All");
      }
      const visibleResults = await searchCurrentFoodDialog(page, query, limit);
      return { results: visibleResults.length > 0 ? visibleResults : fallbackResults, dateStatus };
    }

    return { results: [], dateStatus };
  }

  private async openFoodSearchDialog(page: Page, date?: string) {
    const dateStatus = await this.openDiary(page, date);
    const alreadyOpen = await foodDialogIsOpen(page);
    if (!alreadyOpen) {
      await clickByText(page, /^FOOD$/i);
    }
    await waitForFoodDialogReady(page, Math.min(this.config.navigationTimeoutMs, 12000));
    return dateStatus;
  }

  private async openDiary(page: Page, date?: string) {
    await this.openApp(page, "#diary");
    await this.waitForDiaryText(page).catch(() => undefined);
    return this.selectDiaryDate(page, date);
  }

  private async selectDiaryDate(page: Page, requestedDate?: string): Promise<DiaryDateStatus> {
    const currentDate = todayIso(this.config.timeZone);
    const parsed = normalizeDiaryDateInput(requestedDate, currentDate);
    const base = {
      requestedDate,
      normalizedDate: parsed.date,
      currentDate,
      appliedDate: parsed.date ?? currentDate,
    };

    if (!requestedDate) {
      return { ...base, appliedDate: currentDate, selected: true, strategy: "current" };
    }
    if (!parsed.date) {
      return {
        ...base,
        selected: false,
        strategy: "invalid",
        warning: parsed.warning ?? "Use an ISO diary date like 2026-06-02, or today/yesterday/tomorrow.",
      };
    }

    const days = daysBetweenIso(currentDate, parsed.date);
    if (days === 0) {
      return { ...base, selected: true, strategy: "today", steps: 0 };
    }
    if (Math.abs(days) > MAX_DIARY_ARROW_DAYS) {
      return {
        ...base,
        selected: false,
        strategy: "out_of_range",
        steps: Math.abs(days),
        warning: `Requested diary date is ${Math.abs(days)} days from today. This hosted browser flow only auto-navigates up to ${MAX_DIARY_ARROW_DAYS} days by Cronometer's day arrows.`,
      };
    }

    const direction = days > 0 ? "next" : "previous";
    for (let index = 0; index < Math.abs(days); index += 1) {
      const clicked = await clickDiaryDateArrow(page, direction);
      if (!clicked) {
        return {
          ...base,
          selected: false,
          strategy: "failed",
          steps: index,
          warning: "Could not find Cronometer's diary date arrow. No date-specific write was attempted.",
        };
      }
      await page.waitForTimeout(450);
    }

    await this.waitForDiaryText(page).catch(() => undefined);
    return { ...base, selected: true, strategy: "arrow", steps: Math.abs(days) };
  }

  private async openApp(page: Page, hash = "") {
    const targetUrl = `${CRONOMETER_ORIGIN}/${hash}`;
    await gotoAllowingAbort(page, targetUrl, this.config.navigationTimeoutMs);
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(1200);
    if (await this.isLoggedIn(page)) {
      await this.ensureConfiguredAccount(page, hash);
      if (hash && !page.url().includes(hash)) {
        await gotoAllowingAbort(page, targetUrl, this.config.navigationTimeoutMs);
        await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
        await page.waitForTimeout(900);
      }
      return;
    }

    await this.login(page);
    await gotoAllowingAbort(page, targetUrl, this.config.navigationTimeoutMs);
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(1200);
    if (!(await this.isLoggedIn(page))) {
      const reason = "Cronometer login succeeded but the app page did not load.";
      this.pauseLoginAttempts(reason);
      throw new Error(reason);
    }
    await this.ensureConfiguredAccount(page, hash);
    if (hash && !page.url().includes(hash)) {
      await gotoAllowingAbort(page, targetUrl, this.config.navigationTimeoutMs);
      await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout(900);
    }
  }

  private async ensureConfiguredAccount(page: Page, returnHash: string) {
    const expectedEmail = normalizeEmail(this.config.email);
    if (!expectedEmail) return;

    const cached = cachedAccountVerification;
    if (
      cached?.normalizedEmail === expectedEmail
      && Date.now() - cached.verifiedAt < ACCOUNT_VERIFICATION_TTL_MS
    ) {
      return;
    }

    const currentText = await this.visibleText(page).catch(() => "");
    if (textHasEmail(currentText, expectedEmail)) {
      cachedAccountVerification = { normalizedEmail: expectedEmail, verifiedAt: Date.now(), source: "current-session" };
      return;
    }
    const visibleEmails = extractEmails(currentText);
    if (visibleEmails.length > 0) {
      const detected = visibleEmails.map((email) => redactEmail(email)).join(", ");
      throw new Error(`Cronometer session is logged in, but not as the configured account ${redactEmail(this.config.email)}. Current page showed ${detected}.`);
    }

    if (!this.config.strictAccountVerification) {
      cachedAccountVerification = { normalizedEmail: expectedEmail, verifiedAt: Date.now(), source: "current-session:no-visible-email" };
      return;
    }

    const accountCheck = await withTimeout(
      this.verifyConfiguredAccount(page, expectedEmail, returnHash, "account-page"),
      Math.min(this.config.navigationTimeoutMs, 20000),
      "Timed out verifying the logged-in Cronometer account.",
    );
    if (accountCheck.verified) return;
    if (accountCheck.detectedEmails.length === 0) return;

    const detected = accountCheck.detectedEmails.map((email) => redactEmail(email)).join(", ");
    throw new Error(`Cronometer session is logged in, but not as the configured account ${redactEmail(this.config.email)}. Account page showed ${detected}.`);
  }

  private async verifyConfiguredAccount(page: Page, expectedEmail: string, returnHash: string, source: string, trustFreshLoginWithoutVisibleEmail = false) {
    const currentText = await this.visibleText(page).catch(() => "");
    if (textHasEmail(currentText, expectedEmail)) {
      cachedAccountVerification = { normalizedEmail: expectedEmail, verifiedAt: Date.now(), source };
      return { verified: true, detectedEmails: extractEmails(currentText) };
    }

    const accountText = await this.readAccountPageText(page, returnHash);
    const detectedEmails = extractEmails(accountText);
    if (textHasEmail(accountText, expectedEmail)) {
      cachedAccountVerification = { normalizedEmail: expectedEmail, verifiedAt: Date.now(), source: `${source}:account-page` };
      return { verified: true, detectedEmails };
    }
    if (trustFreshLoginWithoutVisibleEmail && detectedEmails.length === 0) {
      cachedAccountVerification = { normalizedEmail: expectedEmail, verifiedAt: Date.now(), source: `${source}:no-visible-email` };
      return { verified: true, detectedEmails };
    }
    return { verified: false, detectedEmails };
  }

  private async readAccountPageText(page: Page, returnHash: string) {
    const timeout = Math.min(this.config.navigationTimeoutMs, 15000);
    await gotoAllowingAbort(page, `${CRONOMETER_ORIGIN}/#account`, timeout);
    await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
    await page.waitForTimeout(1200);
    const text = await this.visibleText(page).catch(() => "");
    if (returnHash && returnHash !== "#account") {
      await gotoAllowingAbort(page, `${CRONOMETER_ORIGIN}/${returnHash}`, timeout).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
      await page.waitForTimeout(600).catch(() => undefined);
    }
    return text;
  }

  private async login(page: Page) {
    const backoff = this.currentLoginBackoff();
    if (Date.now() < backoff.until) {
      const waitSeconds = Math.ceil((backoff.until - Date.now()) / 1000);
      throw new Error(`Cronometer login is paused for ${waitSeconds}s to avoid more rate-limit attempts. Last failure: ${backoff.reason ?? "unknown"}`);
    }

    if (!this.config.browserProfileDir) {
      await page.context().clearCookies().catch(() => undefined);
      await gotoAllowingAbort(page, `${CRONOMETER_ORIGIN}/login/`, this.config.navigationTimeoutMs);
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      }).catch(() => undefined);
    }
    await gotoAllowingAbort(page, `${CRONOMETER_ORIGIN}/login/`, this.config.navigationTimeoutMs);
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(600);

    const bodyText = await this.visibleText(page);
    if (await this.isLoggedIn(page, bodyText)) return;
    const initialFailure = loginFailureReason(bodyText);
    if (initialFailure) {
      this.pauseLoginAttempts(initialFailure);
      throw new Error(initialFailure);
    }

    if (!this.config.email || !this.config.password) {
      throw new Error("Missing CRONOMETER_EMAIL/CRONOMETER_PASSWORD.");
    }

    let emailInput = await waitForFirstVisibleLocator(page, [
      page.getByLabel(/email/i),
      page.locator("#username"),
      page.locator('input[name="username"]'),
      page.locator('input[type="email"]'),
      page.getByPlaceholder(/email/i),
    ], this.config.navigationTimeoutMs);
    let passwordInput = await waitForFirstVisibleLocator(page, [
      page.getByLabel(/^password$/i),
      page.locator("#password"),
      page.locator('input[name="password"]'),
      page.locator('input[type="password"]'),
      page.getByPlaceholder(/password/i),
    ], this.config.navigationTimeoutMs);
    if (!emailInput || !passwordInput) {
      const clickedLogin = await clickByText(page, /^Log In$/i);
      if (clickedLogin) {
        await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
        await page.waitForTimeout(1200);
        emailInput = await waitForFirstVisibleLocator(page, [
          page.getByLabel(/email/i),
          page.locator("#username"),
          page.locator('input[name="username"]'),
          page.locator('input[type="email"]'),
          page.getByPlaceholder(/email/i),
        ], this.config.navigationTimeoutMs);
        passwordInput = await waitForFirstVisibleLocator(page, [
          page.getByLabel(/^password$/i),
          page.locator("#password"),
          page.locator('input[name="password"]'),
          page.locator('input[type="password"]'),
          page.getByPlaceholder(/password/i),
        ], this.config.navigationTimeoutMs);
      }
    }
    if (!emailInput || !passwordInput) {
      const loginText = compactText(await this.visibleText(page).catch(() => ""), 2000);
      if (await this.isLoggedIn(page, loginText)) return;
      const reason = `Cronometer login form did not render expected fields. Visible text: ${loginText}`;
      this.pauseLoginAttempts(reason);
      throw new Error(reason);
    }

    await emailInput.fill(this.config.email);
    await passwordInput.fill(this.config.password);
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);

    const afterLoginText = await waitForVisibleText(
      page,
      (text) => isLoggedInText(text) || Boolean(loginFailureReason(text)),
      this.config.navigationTimeoutMs,
    );
    if (!(await this.isLoggedIn(page, afterLoginText))) {
      const visibleText = compactText(afterLoginText, 1600);
      const failure = loginFailureReason(afterLoginText)
        ?? `Cronometer login did not reach the app. Check credentials, CAPTCHA, or two-factor prompts. Visible text: ${visibleText}`;
      this.pauseLoginAttempts(failure);
      throw new Error(failure);
    }

    loginBackoffUntil = 0;
    lastLoginFailure = undefined;
    clearPersistentLoginBackoff(this.config.loginBackoffFile);
    cachedStorageState = await page.context().storageState().catch(() => cachedStorageState);
  }

  private async isLoggedIn(page: Page, text?: string) {
    const bodyText = text ?? (await this.visibleText(page).catch(() => ""));
    return isLoggedInText(bodyText);
  }

  private pauseLoginAttempts(reason: string) {
    lastLoginFailure = reason;
    loginBackoffUntil = Date.now() + this.config.loginBackoffMs;
    writePersistentLoginBackoff(this.config.loginBackoffFile, loginBackoffUntil, reason);
  }

  private currentLoginBackoff() {
    const persisted = readPersistentLoginBackoff(this.config.loginBackoffFile);
    if (persisted && persisted.until > loginBackoffUntil) {
      loginBackoffUntil = persisted.until;
      lastLoginFailure = persisted.reason;
      return persisted;
    }
    if (Date.now() >= loginBackoffUntil) {
      return { until: 0, reason: undefined, source: persisted?.source ?? "none" };
    }
    return { until: loginBackoffUntil, reason: lastLoginFailure, source: "memory" as const };
  }

  private async visibleText(page: Page) {
    return page.locator("body").innerText({ timeout: this.config.navigationTimeoutMs });
  }

  private async waitForDiaryText(page: Page) {
    return waitForVisibleText(
      page,
      (text) => /\bDiary\b/i.test(text) && hasDiaryMealSections(text),
      Math.min(this.config.navigationTimeoutMs, 12000),
    );
  }

  private startBackgroundBrowserJob(
    feature: string,
    key: string,
    input: unknown,
    runner: () => Promise<ProviderResult>,
  ): ProviderResult {
    pruneBackgroundBrowserJobs();

    const existingId = backgroundBrowserJobKeys.get(key);
    const existing = existingId ? backgroundBrowserJobs.get(existingId) : undefined;
    if (existing?.status === "running") {
      return this.backgroundBrowserJobAcceptedResult(feature, existing, true);
    }
    if (existing?.status === "completed" && existing.result && existing.result.status !== "busy") {
      return this.result(feature, existing.result.status, {
        ...resultDataObject(existing.result),
        backgroundJob: summarizeBackgroundBrowserJob(existing, Date.now()),
        returnedFromBackgroundJob: true,
      }, existing.result.warning, existing.result.source);
    }
    if (existing?.status === "failed") {
      return this.result(feature, "error", {
        backgroundJob: summarizeBackgroundBrowserJob(existing, Date.now()),
      }, existing.error ?? "Background Cronometer browser job failed.", "browser");
    }

    const now = Date.now();
    const id = `bg_${now.toString(36)}_${++backgroundBrowserJobSeq}`;
    const job: BackgroundBrowserJob = {
      id,
      key,
      feature,
      status: "running",
      startedAt: now,
      updatedAt: now,
      input,
    };
    backgroundBrowserJobs.set(id, job);
    backgroundBrowserJobKeys.set(key, id);

    void Promise.resolve()
      .then(runner)
      .then((result) => {
        job.status = result.status === "error" ? "failed" : "completed";
        job.result = result;
        job.error = result.status === "error" ? result.warning : undefined;
        job.updatedAt = Date.now();
      })
      .catch((error) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.updatedAt = Date.now();
      });

    return this.backgroundBrowserJobAcceptedResult(feature, job, false);
  }

  private backgroundBrowserJobAcceptedResult(feature: string, job: BackgroundBrowserJob, alreadyRunning: boolean): ProviderResult {
    return this.result(feature, "accepted", {
      input: job.input,
      browserOpened: false,
      writeAttempted: true,
      backgroundJob: summarizeBackgroundBrowserJob(job, Date.now()),
      alreadyRunning,
      nextStep: "Call cronometer_runtime_status until this backgroundJob.id is completed or failed. Do not retry the write while it is running.",
    });
  }

  private async waitForAcceptedBackgroundJob(feature: string, result: ProviderResult, waitSeconds: number): Promise<ProviderResult> {
    if (result.status !== "accepted") return result;
    const data = resultDataObject(result);
    const backgroundJob = data.backgroundJob && typeof data.backgroundJob === "object"
      ? data.backgroundJob as { id?: unknown }
      : undefined;
    const jobId = typeof backgroundJob?.id === "string" ? backgroundJob.id : undefined;
    const waitMs = Math.max(0, Math.min(600, Math.floor(waitSeconds))) * 1000;
    if (!jobId || waitMs <= 0) return result;

    const startedAt = Date.now();
    const deadline = startedAt + waitMs;
    while (Date.now() < deadline) {
      const job = backgroundBrowserJobs.get(jobId);
      if (!job) {
        return this.result(feature, "error", {
          ...data,
          waitedForCompletionMs: Date.now() - startedAt,
        }, "Background Cronometer browser job disappeared before completion.", "browser");
      }
      if (job.status === "completed" && job.result) {
        return this.result(feature, job.result.status, {
          ...resultDataObject(job.result),
          backgroundJob: summarizeBackgroundBrowserJob(job, Date.now()),
          returnedFromBackgroundJob: true,
          waitedForCompletionMs: Date.now() - startedAt,
        }, job.result.warning, job.result.source);
      }
      if (job.status === "failed") {
        return this.result(feature, "error", {
          backgroundJob: summarizeBackgroundBrowserJob(job, Date.now()),
          returnedFromBackgroundJob: true,
          waitedForCompletionMs: Date.now() - startedAt,
        }, job.error ?? "Background Cronometer browser job failed.", "browser");
      }
      await delay(500);
    }

    const job = backgroundBrowserJobs.get(jobId);
    return this.result(feature, "accepted", {
      ...data,
      backgroundJob: job ? summarizeBackgroundBrowserJob(job, Date.now()) : data.backgroundJob,
      waitedForCompletionMs: Date.now() - startedAt,
      nextStep: "The background job is still running. Call cronometer_runtime_status until it completes; do not submit the same batch again.",
    }, result.warning, result.source);
  }

  private async withPage(feature: string, handler: (page: Page) => Promise<ProviderResult>): Promise<ProviderResult> {
    if (!this.hasRunnableBrowser()) {
      return this.result(
        feature,
        "not_configured",
        {
          hasCredentials: Boolean(this.config.email && this.config.password),
          hasRemoteBrowser: Boolean(this.config.remoteWsEndpoint),
          localChromium: this.config.localChromium,
        },
        "Enable CRONOMETER_LOCAL_CHROMIUM or set REMOTE_CHROME_WS_ENDPOINT to a Browserless-compatible Chrome WebSocket endpoint.",
        "browser",
      );
    }

    const operationTimeoutMs = this.featureOperationTimeoutMs(feature);
    const queueWaitMs = this.featureQueueWaitTimeoutMs(feature);

    return enqueueBrowserJob(
      () => this.withPageAttemptWithRetry(feature, handler),
      {
        feature,
        maxQueueWaitMs: queueWaitMs,
        staleJobMs: operationTimeoutMs + 30000,
      },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : "Browser automation job failed before starting.";
      const queue = releaseAndSnapshotBrowserQueue(operationTimeoutMs + queueWaitMs);
      if (/Timed out waiting .* browser queue/i.test(message)) {
        return this.browserBusyResult(feature, queue, operationTimeoutMs, message);
      }
      return this.result(feature, "error", {
        activeBrowserJobs,
        queuedBrowserJobs,
        activeBrowserJob,
        queuedBrowserJobSample: Array.from(queuedBrowserJobEntries.entries()).slice(0, 8).map(([id, job]) => ({
          id,
          feature: job.feature,
          ageMs: Date.now() - job.enqueuedAt,
        })),
      }, message, "browser");
    });
  }

  private async withPageAttemptWithRetry(feature: string, handler: (page: Page) => Promise<ProviderResult>): Promise<ProviderResult> {
    const attempts = this.isShortBrowserProbe(feature)
      ? 1
      : Math.max(1, Math.min(this.config.browserRetryCount + 1, 3));
    let lastResult: ProviderResult | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await this.withPageAttempt(feature, handler, attempt);
      lastResult = result;
      if (result.status !== "error" || attempt >= attempts || !isTransientAutomationError(result.warning ?? "")) {
        return result;
      }
      await delay(350 * attempt);
    }

    return lastResult ?? this.result(feature, "error", undefined, "Browser automation failed before producing a result.", "browser");
  }

  private async withPageAttempt(feature: string, handler: (page: Page) => Promise<ProviderResult>, attempt: number): Promise<ProviderResult> {
    let session: BrowserSession | undefined;
    try {
      const loginBackoff = this.currentLoginBackoff();
      if (Date.now() < loginBackoff.until && !this.storageStateInfo().usable) {
        const waitSeconds = Math.ceil((loginBackoff.until - Date.now()) / 1000);
        return this.loginPausedResult(feature, waitSeconds, loginBackoff.reason, { attempt });
      }
      const operationTimeoutMs = this.featureOperationTimeoutMs(feature);
      let newSessionTimedOut = false;
      const newSessionPromise = this.newSession().then((openedSession) => {
        if (newSessionTimedOut) void closeBrowserSession(openedSession);
        return openedSession;
      });
      session = await withTimeoutCleanup(
        newSessionPromise,
        operationTimeoutMs,
        `Timed out opening Cronometer browser session after ${operationTimeoutMs}ms.`,
        () => {
          newSessionTimedOut = true;
        },
      );
      const result = await withTimeoutCleanup(
        handler(session.page),
        operationTimeoutMs,
        `Timed out running ${feature} after ${operationTimeoutMs}ms.`,
        () => closeBrowserSession(session),
      );
      cachedStorageState = await session.context.storageState().catch(() => cachedStorageState);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser automation error";
      if (!this.config.remoteWsEndpoint && this.config.reuseLocalBrowser) {
        await this.closeCachedLocalSession();
      }
      const loginBackoff = this.currentLoginBackoff();
      if (isLoginCooldownError(message) || Date.now() < loginBackoff.until) {
        const waitSeconds = Math.max(1, Math.ceil((loginBackoff.until - Date.now()) / 1000));
        return this.loginPausedResult(feature, waitSeconds, loginBackoff.reason ?? message, { attempt });
      }
      if (this.isShortBrowserProbe(feature) && isProbeTimeoutError(message)) {
        return this.result(feature, "needs_manual_step", {
          attempt,
          browserOpened: true,
          writeAttempted: false,
          retry: "Do not retry this browser preflight repeatedly. Proceed with the direct create/log workflow when nutrition data is already known, or retry once later.",
        }, message, "browser");
      }
      return this.result(feature, "error", { attempt }, message, "browser");
    } finally {
      await closeBrowserSession(session);
    }
  }

  private loginPausedResult(feature: string, waitSeconds: number, reason: string | undefined, data: Record<string, unknown> = {}) {
    const status = feature === "log_food" || feature === "log_foods" ? "not_written_login_paused" : "needs_manual_step";
    return this.result(
      feature,
      status,
      {
        ...data,
        browserOpened: false,
        writeAttempted: false,
        loginPauseSecondsRemaining: waitSeconds,
        lastLoginFailure: reason,
        retry: "Do not retry until the login cooldown expires or storage state is refreshed.",
      },
      `Cronometer login is paused for ${waitSeconds}s. No browser action was attempted.`,
      "browser",
    );
  }

  private browserBusyResult(feature: string, queue: ReturnType<typeof releaseAndSnapshotBrowserQueue>, operationTimeoutMs: number, warning?: string) {
    const activeAgeMs = queue.activeBrowserJob?.ageMs ?? 0;
    const retryAfterSeconds = queue.activeBrowserJob
      ? Math.max(5, Math.ceil(Math.max(5000, operationTimeoutMs - activeAgeMs) / 1000))
      : 5;
    return this.result(
      feature,
      "busy",
      {
        browserOpened: false,
        writeAttempted: false,
        queue,
        retryAfterSeconds,
        retry: "Retry this Cronometer browser tool after the active job finishes. Do not start another browser tool in parallel.",
      },
      warning ?? "Cronometer browser queue is busy. No browser action was attempted.",
      "browser",
    );
  }

  private featureOperationTimeoutMs(feature: string) {
    const timeoutMs = this.config.operationTimeoutMs;
    if (/^search_foods$/.test(feature)) {
      return Math.min(timeoutMs, 30000);
    }
    if (/^(refresh_cronometer_session|cronometer_stability_check|list_custom_foods|find_duplicate_custom_foods|list_custom_meals|list_custom_recipes|list_private_recipe_names)$/.test(feature)) {
      return Math.min(timeoutMs, 60000);
    }
    if (/^read_cronometer_page$/.test(feature)) {
      return Math.min(timeoutMs, 60000);
    }
    if (/^(create_recipe|update_custom_recipe|resolve_recipe_ingredients)$/.test(feature)) {
      return Math.min(timeoutMs, 210000);
    }
    return timeoutMs;
  }

  private featureQueueWaitTimeoutMs(feature: string) {
    if (/^(log_food|log_foods|delete_diary_food_entry|create_custom_food|create_and_log_custom_food|update_custom_food|delete_custom_food|retire_custom_food)$/.test(feature)) {
      return Math.max(10000, Math.min(this.config.operationTimeoutMs, 180000));
    }
    if (/^(refresh_cronometer_session|cronometer_stability_check|search_foods|read_cronometer_page|list_custom_foods|find_duplicate_custom_foods|list_custom_meals|list_custom_recipes|list_private_recipe_names)$/.test(feature)) return 5000;
    if (/^(create_recipe|update_custom_recipe|resolve_recipe_ingredients)$/.test(feature)) return 45000;
    if (/^(list_custom_recipes|list_custom_foods|list_custom_meals)$/.test(feature)) return 20000;
    return 10000;
  }

  private isShortBrowserProbe(feature: string) {
    return /^(refresh_cronometer_session|cronometer_stability_check|search_foods|read_cronometer_page|list_custom_foods|find_duplicate_custom_foods|list_custom_meals|list_custom_recipes|list_private_recipe_names)$/.test(feature);
  }

  private async newSession(): Promise<BrowserSession> {
    if (!this.config.remoteWsEndpoint && this.config.reuseLocalBrowser) {
      const cached = await this.usableCachedLocalSession();
      if (cached) return cached;
    }

    if (!this.config.remoteWsEndpoint && this.config.browserProfileDir) {
      await this.closeCachedLocalSession();
      const context = await chromium.launchPersistentContext(this.config.browserProfileDir, {
        executablePath: resolveChromiumExecutablePath(this.config.chromiumExecutablePath),
        args: this.localChromiumArgs(),
        viewport: BROWSER_VIEWPORT,
        locale: "en-US",
        headless: true,
        timeout: this.config.navigationTimeoutMs,
      });
      await this.seedPersistentProfile(context);
      const page = context.pages().find((candidate) => candidate.url().includes("cronometer.com")) ?? context.pages()[0] ?? await context.newPage();
      await blockHeavyBrowserAssets(page);
      page.setDefaultTimeout(this.config.navigationTimeoutMs);
      page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      const session = {
        browser: context.browser() ?? undefined,
        context,
        page,
        closeContext: this.config.reuseLocalBrowser ? false : true,
        closeBrowser: false,
      };
      if (this.config.reuseLocalBrowser) cachedLocalSession = session;
      return session;
    }

    const browser = this.config.remoteWsEndpoint
      ? await chromium.connectOverCDP(this.config.remoteWsEndpoint, {
          timeout: this.config.navigationTimeoutMs,
        })
      : await this.launchLocalChromium();
    if (this.config.remoteWsEndpoint && this.config.reuseRemoteContext) {
      const context = browser.contexts()[0] ?? await browser.newContext({
        viewport: BROWSER_VIEWPORT,
        locale: "en-US",
        storageState: this.storageState(),
      });
      const page = context.pages().find((candidate) => candidate.url().includes("cronometer.com")) ?? context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(this.config.navigationTimeoutMs);
      page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      return { browser, context, page, closeContext: false, closeBrowser: false };
    }

    if (!this.config.remoteWsEndpoint && this.config.reuseLocalBrowser) {
      await this.closeCachedLocalSession();
      const context = await browser.newContext({
        viewport: BROWSER_VIEWPORT,
        locale: "en-US",
        storageState: this.storageState(),
      });
      const page = await context.newPage();
      page.setDefaultTimeout(this.config.navigationTimeoutMs);
      page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      cachedLocalSession = { browser, context, page, closeContext: false, closeBrowser: false };
      return cachedLocalSession;
    }

    const context = await browser.newContext({
      viewport: BROWSER_VIEWPORT,
      locale: "en-US",
      storageState: this.storageState(),
    });
    const page = await context.newPage();
    await blockHeavyBrowserAssets(page);
    page.setDefaultTimeout(this.config.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    return { browser, context, page };
  }

  private async usableCachedLocalSession(): Promise<BrowserSession | undefined> {
    if (!cachedLocalSession) return undefined;
    if ((cachedLocalSession.browser && !cachedLocalSession.browser.isConnected()) || cachedLocalSession.page.isClosed()) {
      await this.closeCachedLocalSession();
      return undefined;
    }
    return cachedLocalSession;
  }

  private async closeCachedLocalSession() {
    const cached = cachedLocalSession;
    cachedLocalSession = undefined;
    await cached?.context.close().catch(() => undefined);
    await cached?.browser?.close().catch(() => undefined);
  }

  private hasRunnableBrowser() {
    return Boolean(this.config.remoteWsEndpoint || this.config.localChromium);
  }

  private async seedPersistentProfile(context: BrowserContext) {
    const state = this.storageStateInfo().state;
    if (!state || state.cookies.length === 0) return;

    const existingCookies = await context.cookies(CRONOMETER_ORIGIN).catch(() => []);
    const storedCronometerCookies = state.cookies.filter((cookie) => cookie.domain.includes("cronometer.com"));
    if (existingCookies.length >= storedCronometerCookies.length && storedCronometerCookies.length > 0) return;

    await context.addCookies(state.cookies).catch(() => undefined);
    const cronometerOrigins = state.origins.filter((origin) => origin.origin.startsWith(CRONOMETER_ORIGIN));
    if (cronometerOrigins.length === 0) return;

    const page = context.pages()[0] ?? await context.newPage();
    for (const origin of cronometerOrigins) {
      if (origin.localStorage.length === 0) continue;
      await page.goto(origin.origin, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
      await page.evaluate((entries) => {
        for (const entry of entries) localStorage.setItem(entry.name, entry.value);
      }, origin.localStorage).catch(() => undefined);
    }
  }

  private storageState(): ParsedStorageState | undefined {
    return this.storageStateInfo().state;
  }

  private storageStateInfo(): StorageStateInfo {
    if (cachedStorageState) {
      const stats = storageStateStats(cachedStorageState);
      return {
        configured: Boolean(this.config.storageState),
        usable: stats.usable,
        source: "warm-cache",
        state: cachedStorageState,
        cookieCount: stats.cookieCount,
        originCount: stats.originCount,
      };
    }
    if (!this.config.storageState) return { configured: false, usable: false, source: "none" };
    const raw = this.config.storageState.trim();
    try {
      const state = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64url").toString("utf8"));
      const stats = storageStateStats(state);
      return {
        configured: true,
        usable: stats.usable,
        source: stats.usable ? "env" : "invalid",
        state: stats.state,
        cookieCount: stats.cookieCount,
        originCount: stats.originCount,
      };
    } catch {
      try {
        const state = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
        const stats = storageStateStats(state);
        return {
          configured: true,
          usable: stats.usable,
          source: stats.usable ? "env" : "invalid",
          state: stats.state,
          cookieCount: stats.cookieCount,
          originCount: stats.originCount,
        };
      } catch {
        return { configured: true, usable: false, source: "invalid" };
      }
    }
  }

  private async launchLocalChromium() {
    return chromium.launch({
      executablePath: resolveChromiumExecutablePath(this.config.chromiumExecutablePath),
      args: this.localChromiumArgs(),
      headless: true,
      timeout: this.config.navigationTimeoutMs,
    });
  }

  private localChromiumArgs() {
    return [
        "--disable-background-networking",
        "--disable-client-side-phishing-detection",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-gpu",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-sync",
        "--disable-features=AudioServiceOutOfProcess,BackForwardCache,CalculateNativeWinOcclusion,MediaRouter,OptimizationHints,Translate",
        "--disable-application-cache",
        "--disk-cache-size=1",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--no-sandbox",
        "--no-zygote",
        "--password-store=basic",
        "--renderer-process-limit=1",
        "--use-mock-keychain",
        "--blink-settings=imagesEnabled=false",
      ];
  }
}

async function clickByText(page: Page, label: string | RegExp) {
  const candidates = [
    page.getByRole("button", { name: label }),
    page.getByRole("link", { name: label }),
    page.locator(clickableTextSelector()).filter({ hasText: label }),
    label instanceof RegExp ? page.getByText(label) : page.getByText(label, { exact: true }),
    ...(typeof label === "string" ? [page.getByText(label)] : []),
  ];

  for (const candidate of candidates) {
    if (await clickFirstVisible(candidate)) return true;
  }

  const box = await findVisibleTextClickBox(page, label);
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

async function gotoAllowingAbort(page: Page, url: string, timeout: number) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/net::ERR_ABORTED|navigation.*interrupted/i.test(message)) throw error;
  }
}

async function clickOptionalSaveConfirmation(page: Page) {
  const dialog = page.locator(".gwt-DialogBox:visible, [role='dialog']:visible, .modal:visible, .popupContent:visible").last();
  if ((await dialog.count().catch(() => 0)) === 0 || !(await dialog.isVisible().catch(() => false))) return false;
  return clickFirstVisible(dialog.locator(clickableTextSelector()).filter({ hasText: /^(SAVE|CONFIRM|YES|OK)$/i }));
}

interface DeleteConfirmationOutcome {
  dialogVisible: boolean;
  dialogText?: string;
  dependencyWarning: boolean;
  clicked: boolean;
  cancelled: boolean;
  blocked: boolean;
  retireInstead: boolean;
}

async function handleOptionalDeleteConfirmation(page: Page, name: string, ifUsed: "stop" | "retire" | "force" = "stop"): Promise<DeleteConfirmationOutcome> {
  const dialog = page.locator(".gwt-DialogBox:visible, [role='dialog']:visible, .modal:visible, .popupContent:visible").last();
  if ((await dialog.count().catch(() => 0)) === 0 || !(await dialog.isVisible().catch(() => false))) {
    return { dialogVisible: false, dependencyWarning: false, clicked: false, cancelled: false, blocked: false, retireInstead: false };
  }
  const dialogText = await dialog.innerText().catch(() => "");
  if (dialogText && !dialogText.toLowerCase().includes(name.toLowerCase()) && !/\b(delete|remove)\b/i.test(dialogText)) {
    return { dialogVisible: true, dialogText, dependencyWarning: false, clicked: false, cancelled: false, blocked: false, retireInstead: false };
  }

  const dependencyWarning = deleteDialogHasDependencyWarning(dialogText);
  if (dependencyWarning && ifUsed !== "force") {
    const cancelled = await cancelVisibleDialog(page, dialog);
    return {
      dialogVisible: true,
      dialogText,
      dependencyWarning,
      clicked: false,
      cancelled,
      blocked: ifUsed === "stop",
      retireInstead: ifUsed === "retire",
    };
  }

  const clicked = await clickFirstVisible(dialog.locator(clickableTextSelector()).filter({ hasText: /^(DELETE|REMOVE|YES|OK|CONFIRM)$/i }));
  return { dialogVisible: true, dialogText, dependencyWarning, clicked, cancelled: false, blocked: false, retireInstead: false };
}

function deleteDialogHasDependencyWarning(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return /\b(used|in use|referenced|associated|linked|logged|diary|entries|servings|recipes|meals|history)\b/i.test(normalized)
    && /\b(delete|remove|deleting|removing)\b/i.test(normalized);
}

async function cancelVisibleDialog(page: Page, dialog: ReturnType<Page["locator"]>) {
  const clicked = await clickFirstVisible(dialog.locator(clickableTextSelector()).filter({ hasText: /^(CANCEL|NO|KEEP|CLOSE|BACK)$/i }));
  if (clicked) return true;
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(350);
  return !(await dialog.isVisible().catch(() => false));
}

async function clickFirstVisible(locator: ReturnType<Page["locator"]>) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 12); index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    await item.scrollIntoViewIfNeeded().catch(() => undefined);
    try {
      await item.click({ timeout: 2500 });
      return true;
    } catch {
      try {
        await item.click({ timeout: 2500, force: true });
        return true;
      } catch {
        // Keep trying lower-confidence candidates.
      }
    }
  }
  return false;
}

function clickableTextSelector() {
  return [
    "button",
    "a",
    "[role='button']",
    "input[type='button']",
    "input[type='submit']",
    "[onclick]",
    "[tabindex]",
    ".gwt-Button",
    ".gwt-ToggleButton",
    ".button-panel-btn",
    ".btn",
    ".clickable",
  ].join(",");
}

async function findVisibleTextClickBox(page: Page, label: string | RegExp) {
  return page.evaluate((matcher) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const regex = matcher.kind === "regex" ? new RegExp(matcher.source, matcher.flags) : undefined;
    const expected = matcher.kind === "text" ? normalize(matcher.value).toLowerCase() : undefined;
    const selector = matcher.clickableSelector;

    const textMatches = (value: string) => {
      const normalized = normalize(value);
      if (!normalized) return false;
      if (regex) return regex.test(normalized);
      return Boolean(expected && normalized.toLowerCase().includes(expected));
    };

    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const depth = (element: Element) => {
      let current: Element | null = element;
      let total = 0;
      while (current) {
        total += 1;
        current = current.parentElement;
      }
      return total;
    };

    const candidates = Array.from(document.querySelectorAll("body *"))
      .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
      .map((element) => {
        const text =
          normalize(element.innerText) ||
          normalize(element.textContent) ||
          normalize(element.getAttribute("aria-label")) ||
          normalize(element.getAttribute("title")) ||
          (element instanceof HTMLInputElement ? normalize(element.value) : "");
        if (!textMatches(text)) return undefined;

        const rect = element.getBoundingClientRect();
        const clickable = element.closest(selector);
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          score: [
            regex || text.toLowerCase() === expected ? 0 : 1,
            clickable ? 0 : 1,
            Math.round(rect.width * rect.height),
            -depth(element),
          ],
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .sort((a, b) => {
        for (let index = 0; index < a.score.length; index += 1) {
          const delta = a.score[index] - b.score[index];
          if (delta !== 0) return delta;
        }
        return 0;
      });

    return candidates[0] ? {
      x: candidates[0].x,
      y: candidates[0].y,
      width: candidates[0].width,
      height: candidates[0].height,
    } : undefined;
  }, serializeTextMatcher(label));
}

function serializeTextMatcher(label: string | RegExp) {
  if (label instanceof RegExp) {
    return {
      kind: "regex" as const,
      source: label.source,
      flags: label.flags.replace(/[gy]/g, ""),
      clickableSelector: clickableTextSelector(),
    };
  }
  return {
    kind: "text" as const,
    value: label,
    clickableSelector: clickableTextSelector(),
  };
}

async function enqueueBrowserJob<T>(
  task: () => Promise<T>,
  options: { feature: string; maxQueueWaitMs: number; staleJobMs?: number },
): Promise<T> {
  releaseAndSnapshotBrowserQueue(options.staleJobMs);
  const epoch = browserQueueEpoch;
  const id = ++browserJobSeq;
  const enqueuedAt = Date.now();
  let started = false;
  let canceled = false;
  let dequeued = false;
  queuedBrowserJobs += 1;
  queuedBrowserJobEntries.set(id, { feature: options.feature, enqueuedAt });

  const dequeue = () => {
    if (dequeued) return;
    dequeued = true;
    queuedBrowserJobs = Math.max(0, queuedBrowserJobs - 1);
    queuedBrowserJobEntries.delete(id);
  };

  const result = new Promise<T>((resolve, reject) => {
    const queueTimer = setTimeout(() => {
      if (started) return;
      canceled = true;
      dequeue();
      reject(new Error(`Timed out waiting ${options.maxQueueWaitMs}ms for the Cronometer browser queue before starting ${options.feature}. Try again after the active browser job finishes.`));
    }, options.maxQueueWaitMs);

    browserQueue = browserQueue
      .catch(() => undefined)
      .then(async () => {
        if (canceled || epoch !== browserQueueEpoch) return;
        started = true;
        clearTimeout(queueTimer);
        dequeue();
        activeBrowserJobs += 1;
        activeBrowserJob = { id, feature: options.feature, startedAt: Date.now(), staleJobMs: options.staleJobMs };
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        } finally {
          if (epoch === browserQueueEpoch) {
            activeBrowserJobs = Math.max(0, activeBrowserJobs - 1);
            if (activeBrowserJob?.id === id) activeBrowserJob = undefined;
          }
        }
      });
  });

  return result;
}

export function releaseAndSnapshotBrowserQueue(staleJobMs = 240000) {
  const now = Date.now();
  const activeStaleJobMs = activeBrowserJob?.staleJobMs ?? staleJobMs;
  const staleActiveJob = activeBrowserJob && now - activeBrowserJob.startedAt > activeStaleJobMs
    ? { ...activeBrowserJob, ageMs: now - activeBrowserJob.startedAt, staleJobMs: activeStaleJobMs }
    : undefined;

  if (staleActiveJob) {
    activeBrowserJob = undefined;
    activeBrowserJobs = 0;
    browserQueue = Promise.resolve();
    browserQueueEpoch += 1;
  }

  return {
    activeBrowserJobs,
    queuedBrowserJobs,
    activeBrowserJob: activeBrowserJob
      ? {
        ...activeBrowserJob,
        ageMs: now - activeBrowserJob.startedAt,
      }
      : undefined,
    queuedBrowserJobSample: Array.from(queuedBrowserJobEntries.entries()).slice(0, 8).map(([id, job]) => ({
      id,
      feature: job.feature,
      ageMs: now - job.enqueuedAt,
    })),
    staleActiveJob,
  };
}

export function __resetBrowserQueueForTests() {
  browserQueue = Promise.resolve();
  activeBrowserJobs = 0;
  queuedBrowserJobs = 0;
  browserQueueEpoch = 0;
  activeBrowserJob = undefined;
  queuedBrowserJobEntries.clear();
}

export function __runBrowserQueueJobForTests<T>(
  feature: string,
  task: () => Promise<T>,
  options: { maxQueueWaitMs?: number; staleJobMs?: number } = {},
) {
  return enqueueBrowserJob(task, {
    feature,
    maxQueueWaitMs: options.maxQueueWaitMs ?? 1000,
    staleJobMs: options.staleJobMs,
  });
}

export function __setActiveBrowserJobForTests(feature: string, startedAt: number) {
  activeBrowserJobs = 1;
  activeBrowserJob = { id: ++browserJobSeq, feature, startedAt };
}

function backgroundBrowserJobKey(feature: string, input: unknown) {
  const digest = createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 24);
  return `${feature}:${digest}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "\"__undefined__\"";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function pruneBackgroundBrowserJobs(now = Date.now()) {
  const maxAgeMs = 6 * 60 * 60 * 1000;
  const completed = Array.from(backgroundBrowserJobs.values())
    .filter((job) => job.status !== "running")
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const keepCompleted = new Set(completed.slice(0, 20).map((job) => job.id));

  for (const job of backgroundBrowserJobs.values()) {
    if (job.status === "running") continue;
    if (keepCompleted.has(job.id) && now - job.updatedAt <= maxAgeMs) continue;
    backgroundBrowserJobs.delete(job.id);
    if (backgroundBrowserJobKeys.get(job.key) === job.id) backgroundBrowserJobKeys.delete(job.key);
  }
}

function summarizeBackgroundBrowserJobs(now = Date.now()) {
  pruneBackgroundBrowserJobs(now);
  const jobs = Array.from(backgroundBrowserJobs.values());
  const running = jobs
    .filter((job) => job.status === "running")
    .sort((left, right) => left.startedAt - right.startedAt)
    .map((job) => summarizeBackgroundBrowserJob(job, now));
  const recent = jobs
    .filter((job) => job.status !== "running")
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 10)
    .map((job) => summarizeBackgroundBrowserJob(job, now));
  return {
    runningCount: running.length,
    recentCount: recent.length,
    running,
    recent,
  };
}

function summarizeBackgroundBrowserJob(job: BackgroundBrowserJob, now = Date.now()) {
  return {
    id: job.id,
    feature: job.feature,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    ageMs: now - job.startedAt,
    finishedAgoMs: job.status === "running" ? undefined : now - job.updatedAt,
    result: job.result ? summarizeProviderResultForBackground(job.result) : undefined,
    error: job.error,
  };
}

function summarizeProviderResultForBackground(result: ProviderResult) {
  const data = resultDataObject(result);
  return {
    feature: result.feature,
    status: result.status,
    warning: result.warning,
    source: result.source,
    data: compactBackgroundResultData(data),
  };
}

function resultDataObject(result: ProviderResult): Record<string, unknown> {
  return result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
}

function compactBackgroundResultData(data: Record<string, unknown>) {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/^(visibleText|rawText|afterSaveText)$/i.test(key)) continue;
    if (key === "createCustomFood" || key === "logFood") {
      compacted[key] = compactNestedProviderResult(value);
      continue;
    }
    compacted[key] = value;
  }
  return compacted;
}

function compactNestedProviderResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as ProviderResult;
  return {
    feature: result.feature,
    status: result.status,
    warning: result.warning,
    source: result.source,
    data: resultDataObject(result).visibleText ? compactBackgroundResultData(resultDataObject(result)) : result.data,
  };
}

async function blockHeavyBrowserAssets(page: Page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const resourceType = route.request().resourceType();
    const isCronometer = url.hostname === "cronometer.com" || url.hostname.endsWith(".cronometer.com");
    if (!isCronometer || resourceType === "image" || resourceType === "media" || resourceType === "font") {
      await route.abort().catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  }).catch(() => undefined);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withTimeoutCleanup<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout: () => void | Promise<void>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void Promise.resolve(onTimeout()).catch(() => undefined);
          reject(new Error(message));
        }, ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function closeBrowserSession(session: BrowserSession | undefined) {
  if (session?.closeContext !== false) await session?.context.close().catch(() => undefined);
  if (session?.closeBrowser !== false) await session?.browser?.close().catch(() => undefined);
}

function isTransientAutomationError(message: string) {
  if (/Too Many Attempts|captcha|robot|verify|invalid|incorrect|two.factor|2fa|login is paused/i.test(message)) return false;
  if (/Timed out (running|opening)/i.test(message)) return false;
  return /Target page|context.*closed|browser.*closed|browser.*disconnected|Execution context|Navigation timeout|Timeout .* exceeded|Timed out|Protocol error|net::ERR|ECONNRESET|EPIPE/i.test(message);
}

function shouldRunConfirmedWrite(input: { dryRun?: boolean; confirmed?: boolean }, writeEnabled: boolean) {
  return writeEnabled && input.confirmed === true && input.dryRun !== true;
}

function writeGateReason(input: { dryRun?: boolean; confirmed?: boolean }, writeEnabled: boolean) {
  if (!writeEnabled) return "Cronometer writes are disabled on the server.";
  if (input.dryRun === true) return "Dry-run preview requested.";
  if (input.confirmed !== true) return "User confirmation is required before this write tool opens Cronometer.";
  return "Write gate did not pass.";
}

function writeGateReasonForFoodLog(input: { dryRun?: boolean; confirmed?: boolean }, writeEnabled: boolean, requireFoodConfirmation: boolean) {
  if (!writeEnabled) return "Cronometer writes are disabled on the server.";
  if (input.dryRun === true) return "Dry-run preview requested.";
  if (input.confirmed === false) return "The request explicitly declined confirmation.";
  if (requireFoodConfirmation && input.confirmed !== true) return "Food log confirmation is required by CRONOMETER_REQUIRE_FOOD_CONFIRMATION.";
  return "Food log write gate did not pass.";
}

function normalizedToFoodInput(normalized: NormalizedFoodLog, original: FoodLogInput): FoodLogInput {
  return {
    ...original,
    query: normalized.query,
    meal: normalized.meal,
    date: normalized.date,
    amount: normalized.amount,
    unit: normalized.unit,
    selectedName: normalized.selectedName,
    selectedSource: normalized.selectedSource,
    idempotencyKey: normalized.idempotencyKey,
  };
}

function normalizeFoodLogBatchItems(input: FoodLogBatchInput, timeZone: string) {
  return (input.items ?? []).map((item, index) => {
    const merged: FoodLogInput = {
      ...item,
      date: item.date ?? input.date,
      meal: item.meal ?? input.meal,
      dryRun: item.dryRun ?? input.dryRun,
      confirmed: item.confirmed ?? input.confirmed,
    };
    return {
      index,
      input: merged,
      normalized: normalizeFoodLogInput(merged, timeZone),
    };
  });
}

function summarizeBatchFoodLogResult(index: number, normalized: NormalizedFoodLog, result: ProviderResult) {
  const data = resultDataObject(result);
  const logged = data.logged && typeof data.logged === "object" ? data.logged as Record<string, unknown> : undefined;
  const selection = data.selection && typeof data.selection === "object" ? data.selection as Record<string, unknown> : undefined;
  const selectedResult = selection?.result && typeof selection.result === "object"
    ? selection.result as Record<string, unknown>
    : undefined;
  return {
    index,
    query: normalized.query,
    date: normalized.date,
    meal: normalized.meal,
    amount: normalized.amount,
    unit: normalized.unit,
    idempotencyKey: normalized.idempotencyKey,
    status: result.status,
    warning: result.warning,
    selectedName: stringValue(logged?.selectedName) ?? stringValue(selectedResult?.name) ?? normalized.selectedName,
    selectedSource: stringValue(logged?.selectedSource) ?? stringValue(selectedResult?.source) ?? normalized.selectedSource,
    queryUsed: stringValue(data.queryUsed),
    verification: data.verification,
    retry: data.retry,
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function foodLogBatchItemSucceeded(status: ProviderResult["status"]) {
  return status === "written" || status === "already_exists";
}

function countBatchFoodLogStatuses(statuses: Array<ProviderResult["status"]>) {
  const counts: Record<string, number> = {};
  for (const status of statuses) {
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function batchFoodLogStatus(statuses: Array<ProviderResult["status"]>, expectedCount: number): ProviderResult["status"] {
  if (statuses.length === 0) return "needs_manual_step";
  if (statuses.length < expectedCount) return "needs_manual_step";
  if (statuses.every(foodLogBatchItemSucceeded)) return "written";
  if (statuses.some((status) => status === "possibly_written_verify_failed")) return "possibly_written_verify_failed";
  if (statuses.some((status) => status === "error")) return "error";
  if (statuses.every((status) => status === "not_written_login_paused")) return "not_written_login_paused";
  if (statuses.every((status) => status === "not_written_not_found")) return "not_written_not_found";
  if (statuses.every((status) => status === "not_written_ambiguous")) return "not_written_ambiguous";
  if (statuses.every((status) => status === "busy")) return "busy";
  return "needs_manual_step";
}

function batchFoodLogWarning(
  status: ProviderResult["status"],
  attemptedCount: number,
  expectedCount: number,
  counts: Record<string, number>,
) {
  if (status === "written") return undefined;
  const writtenCount = (counts.written ?? 0) + (counts.already_exists ?? 0);
  if (status === "possibly_written_verify_failed") {
    return `At least one batch item may have been written but did not verify. ${writtenCount}/${expectedCount} items were written or already present. Inspect per-item statuses before retrying anything.`;
  }
  if (attemptedCount < expectedCount) {
    return `Batch stopped after ${attemptedCount}/${expectedCount} items. ${writtenCount} items were written or already present.`;
  }
  return `Batch completed with ${writtenCount}/${expectedCount} items written or already present. Inspect per-item statuses and retry only unresolved items.`;
}

function normalizeDiaryFoodDeleteInput(input: DiaryFoodDeleteInput, timeZone: string): NormalizedDiaryFoodDelete {
  return {
    original: input,
    date: normalizeFoodLogDate(input.date, timeZone),
    meal: normalizeFoodLogMeal(input.meal),
    name: input.name?.replace(/\s+/g, " ").trim() ?? "",
    amount: input.amount,
    unit: normalizeFoodLogUnit(input.unit),
  };
}

function diaryDeleteTargetAsFoodLog(target: NormalizedDiaryFoodDelete): NormalizedFoodLog {
  return {
    original: {
      query: target.name,
      date: target.date,
      meal: target.meal,
      amount: target.amount,
      unit: target.unit,
      selectedName: target.name,
    },
    query: target.name,
    searchQueries: [target.name],
    meal: target.meal,
    date: target.date,
    amount: target.amount,
    unit: target.unit,
    selectedName: target.name,
    idempotencyKey: "",
  };
}

function findDiaryFoodEntryMatches(text: string, target: NormalizedDiaryFoodDelete): DiaryFoodEntryMatch[] {
  const sectionText = diaryMealSectionText(text, target.meal);
  if (!sectionText) return [];
  const normalizedTargetName = normalizeFoodName(target.name);
  const lines = sectionText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const matches: DiaryFoodEntryMatch[] = [];
  const normalizedFoodLog = diaryDeleteTargetAsFoodLog(target);

  for (let index = 0; index < lines.length; index += 1) {
    if (normalizeFoodName(lines[index]) !== normalizedTargetName) continue;
    const entryText = lines.slice(index, index + 8).join("\n");
    const verification = verifyFoodLogInDiaryText(`${target.meal}\n${entryText}`, normalizedFoodLog);
    if (verification.status === "verified") matches.push({ entryText });
  }

  return matches;
}

function diaryMealSectionText(text: string, meal: string) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === meal.toLowerCase());
  if (start < 0) return "";
  const knownMeals = new Set(["breakfast", "lunch", "dinner", "snacks", "supplements", "health"]);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const normalized = lines[index].trim().toLowerCase();
    if (knownMeals.has(normalized)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

async function clickDiaryFoodEntryRow(page: Page, target: NormalizedDiaryFoodDelete, match: DiaryFoodEntryMatch) {
  const normalizedTargetName = normalizeFoodName(target.name);
  const rows = page.locator("tr:visible,[role='row']:visible");
  const count = await rows.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const rowText = await row.innerText().catch(() => "");
    if (!rowText || !rowText.includes(target.name)) continue;
    if (!findDiaryFoodEntryMatches(`${target.meal}\n${rowText}`, target).length) continue;
    await row.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await row.boundingBox().catch(() => undefined);
    if (box) {
      await page.mouse.click(box.x + Math.min(30, Math.max(8, box.width / 2)), box.y + box.height / 2);
    } else {
      await row.click().catch(async () => row.click({ force: true }));
    }
    await page.waitForTimeout(500);
    return { clicked: true as const, strategy: "row" as const, rowText: compactText(rowText, 500) };
  }

  const exactFood = page.getByText(target.name, { exact: true });
  const exactCount = await exactFood.count().catch(() => 0);
  if (exactCount === 1 || (exactCount > 0 && normalizeFoodName(match.entryText).includes(normalizedTargetName))) {
    const first = exactFood.first();
    if (await first.isVisible().catch(() => false)) {
      await first.click().catch(async () => first.click({ force: true }));
      await page.waitForTimeout(500);
      return { clicked: true as const, strategy: "exact-text" as const, rowText: compactText(match.entryText, 500) };
    }
  }

  return {
    clicked: false as const,
    warning: exactCount > 1
      ? "Multiple visible rows share that food name; refused to use a broad text click."
      : "Could not find a visible matching diary row.",
  };
}

async function confirmSelectedDiaryEntryDelete(page: Page) {
  const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  const expected = /Delete Items\?\s*Delete the selected entries\?/i.test(text);
  if (!expected) {
    return {
      confirmed: false as const,
      dialogText: compactText(text.match(/Delete[\s\S]{0,400}/i)?.[0] ?? text, 700),
      warning: "Expected Cronometer's selected-entry delete confirmation did not appear.",
    };
  }

  const ok = page.getByText(/^OK$/).last();
  if (!(await ok.isVisible().catch(() => false))) {
    return {
      confirmed: false as const,
      dialogText: compactText(text.match(/Delete[\s\S]{0,400}/i)?.[0] ?? text, 700),
      warning: "Delete confirmation appeared, but the OK button was not visible.",
    };
  }
  await ok.click().catch(async () => ok.click({ force: true }));
  return {
    confirmed: true as const,
    dialogText: "Delete Items? Delete the selected entries?",
  };
}

async function triggerSelectedDiaryEntryDelete(page: Page) {
  const attempts = [];
  for (const key of ["Delete", "Backspace"]) {
    await page.keyboard.press(key).catch(() => undefined);
    await page.waitForTimeout(600);
    if (await deleteConfirmationVisible(page)) {
      return { triggered: true as const, strategy: `keyboard:${key}`, attempts };
    }
    attempts.push(`keyboard:${key}`);
  }

  const textClicked = await clickByText(page, /^(DELETE|Delete|delete|REMOVE|Remove|remove|delete_outline|delete_forever|trash)$/i);
  if (textClicked) {
    await page.waitForTimeout(700);
    if (await deleteConfirmationVisible(page)) {
      return { triggered: true as const, strategy: "visible-text", attempts };
    }
    attempts.push("visible-text");
  }

  const iconClicked = await clickFirstVisible(page.locator([
    "[aria-label*='delete' i]:visible",
    "[aria-label*='remove' i]:visible",
    "[title*='delete' i]:visible",
    "[title*='remove' i]:visible",
    "button:visible:has-text('delete')",
    "[role='button']:visible:has-text('delete')",
    ".material-icons:visible:has-text('delete')",
  ].join(",")));
  if (iconClicked) {
    await page.waitForTimeout(700);
    if (await deleteConfirmationVisible(page)) {
      return { triggered: true as const, strategy: "icon-selector", attempts };
    }
    attempts.push("icon-selector");
  }

  return { triggered: false as const, attempts, warning: "Could not trigger Cronometer's selected diary-entry delete confirmation." };
}

async function deleteConfirmationVisible(page: Page) {
  const text = await page.locator("body").innerText({ timeout: 1200 }).catch(() => "");
  return /Delete Items\?\s*Delete the selected entries\?/i.test(text) ||
    /\bDelete\b[\s\S]{0,80}\bselected entr/i.test(text);
}

async function clickDiaryDateArrow(page: Page, direction: "previous" | "next") {
  const nav = page.locator(".sidebar-diary-date .diary-date-nav:visible, .diary-date-nav:visible").first();
  if (!(await nav.isVisible().catch(() => false))) return false;

  const box = await nav.boundingBox().catch(() => undefined);
  if (!box) return false;

  const x = direction === "previous" ? box.x + 12 : box.x + box.width - 12;
  await page.mouse.click(x, box.y + box.height / 2);
  return true;
}

function normalizeDiaryDateInput(value: string | undefined, today: string): { date?: string; warning?: string } {
  const normalized = value?.trim();
  if (!normalized) return {};

  const lower = normalized.toLowerCase();
  if (lower === "today") return { date: today };
  if (lower === "yesterday") return { date: addDaysIso(today, -1) };
  if (lower === "tomorrow") return { date: addDaysIso(today, 1) };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return { warning: "cronogpt currently accepts diary dates as YYYY-MM-DD, today, yesterday, or tomorrow." };
  }

  return isValidIsoDate(normalized)
    ? { date: normalized }
    : { warning: `Invalid diary date: ${normalized}` };
}

function todayIso(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isValidIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDaysIso(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function daysBetweenIso(from: string, to: string) {
  const fromTime = isoDateMs(from);
  const toTime = isoDateMs(to);
  return Math.round((toTime - fromTime) / 86400000);
}

function isoDateMs(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

async function waitForVisibleText(page: Page, isReady: (text: string) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";

  while (Date.now() < deadline) {
    lastText = await page.locator("body").innerText({ timeout: Math.min(3000, timeoutMs) }).catch(() => lastText);
    if (isReady(lastText)) return lastText;
    await page.waitForTimeout(Math.min(600, Math.max(0, deadline - Date.now())));
  }

  return lastText || page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
}

function hasDiaryMealSections(text: string) {
  return DIARY_MEAL_SECTION_RE.test(text);
}

function storageStateStats(state: unknown): {
  usable: boolean;
  cookieCount: number;
  originCount: number;
  state?: ParsedStorageState;
} {
  if (!state || typeof state !== "object") {
    return { usable: false, cookieCount: 0, originCount: 0 };
  }
  const maybeState = state as { cookies?: unknown[]; origins?: unknown[] };
  const cookieCount = Array.isArray(maybeState.cookies) ? maybeState.cookies.length : 0;
  const originCount = Array.isArray(maybeState.origins) ? maybeState.origins.length : 0;
  const usable = (cookieCount > 0 || originCount > 0) && Array.isArray(maybeState.cookies) && Array.isArray(maybeState.origins);
  return {
    usable,
    cookieCount,
    originCount,
    state: usable ? (state as ParsedStorageState) : undefined,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LoginBackoffSnapshot = { until: number; reason?: string; source: "memory" | "file" | "none" };

function readPersistentLoginBackoff(filePath?: string): LoginBackoffSnapshot | undefined {
  if (!filePath || !existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { until?: unknown; reason?: unknown };
    const until = typeof parsed.until === "number" ? parsed.until : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
    if (Date.now() >= until) {
      clearPersistentLoginBackoff(filePath);
      return { until: 0, reason, source: "none" };
    }
    return { until, reason, source: "file" };
  } catch {
    return { until: 0, reason: "Ignored unreadable Cronometer login cooldown file.", source: "none" };
  }
}

function writePersistentLoginBackoff(filePath: string | undefined, until: number, reason: string) {
  if (!filePath) return;
  try {
    writeFileSync(filePath, JSON.stringify({ until, reason, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
  } catch {
    // Cooldown persistence should never make a browser operation fail harder.
  }
}

function clearPersistentLoginBackoff(filePath?: string) {
  if (!filePath || !existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors; the in-memory state is still authoritative.
  }
}

function resolveChromiumExecutablePath(configuredPath?: string) {
  if (configuredPath) return configuredPath;
  for (const candidate of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function runUiStep(page: Page, step: UiFlowStep) {
  if (step.action === "read") {
    return { status: "ok" as const };
  }

  if (step.action === "wait") {
    const ms = Math.max(0, Math.min(step.ms ?? 1000, 5000));
    await page.waitForTimeout(ms);
    return { status: "ok" as const, waitedMs: ms };
  }

  if (step.action === "press") {
    if (!step.key) return { status: "not_found" as const, warning: "Missing key." };
    await page.keyboard.press(step.key);
    return { status: "ok" as const, key: step.key };
  }

  if (step.action === "clickText") {
    if (!step.text) return { status: "not_found" as const, warning: "Missing text." };
    const clicked = await clickByText(page, step.exact === false ? new RegExp(escapeRegExp(step.text), "i") : new RegExp(`^${escapeRegExp(step.text)}$`, "i"));
    return clicked ? { status: "ok" as const, clickedText: step.text } : { status: "not_found" as const, warning: `Could not find clickable text: ${step.text}` };
  }

  if (step.action === "fillLabel") {
    if (!step.label || step.value === undefined) return { status: "not_found" as const, warning: "Missing label or value." };
    const locator = page.getByLabel(new RegExp(escapeRegExp(step.label), "i")).first();
    if (!(await locator.isVisible().catch(() => false))) {
      return { status: "not_found" as const, warning: `Could not find visible label: ${step.label}` };
    }
    await locator.fill(step.value);
    return { status: "ok" as const, filledLabel: step.label };
  }

  if (step.action === "fillPlaceholder") {
    if (!step.placeholder || step.value === undefined) return { status: "not_found" as const, warning: "Missing placeholder or value." };
    const locator = page.getByPlaceholder(new RegExp(escapeRegExp(step.placeholder), "i")).first();
    if (!(await locator.isVisible().catch(() => false))) {
      return { status: "not_found" as const, warning: `Could not find visible placeholder: ${step.placeholder}` };
    }
    await locator.fill(step.value);
    return { status: "ok" as const, filledPlaceholder: step.placeholder };
  }

  return { status: "not_found" as const, warning: `Unsupported action: ${step.action}` };
}

function isDangerousClickText(value: string) {
  return /\b(delete account|bulk delete|delete all|delete diary|delete data|remove account|reset account|cancel subscription|erase)\b/i.test(value);
}

function activeDialog(page: Page) {
  return page.locator(".pretty-dialog, [role='dialog'], .gwt-DialogBox, .popupContent").last();
}

async function foodDialogIsOpen(page: Page) {
  const dialog = activeDialog(page);
  if (!(await dialog.isVisible().catch(() => false))) return false;
  const text = await dialog.innerText({ timeout: 1000 }).catch(() => "");
  return /\b(Add Food to Diary|Description\s+Source|SEARCH)\b/i.test(text);
}

async function waitForFoodDialogReady(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let sawFoodDialog = false;

  while (Date.now() < deadline) {
    const dialog = activeDialog(page);
    const text = await dialog.innerText({ timeout: 1000 }).catch(() => "");
    sawFoodDialog ||= /\b(Add Food to Diary|Description\s+Source|SEARCH)\b/i.test(text);
    if (sawFoodDialog && !/Loading(?:\.\.\.)?/i.test(text)) return true;
    await page.waitForTimeout(250);
  }

  return sawFoodDialog;
}

async function clickDialogButton(page: Page, label: string | RegExp) {
  const dialog = activeDialog(page);
  const candidates = [
    dialog.getByRole("button", { name: label }),
    dialog.locator("button,.gwt-Button,[role='button']").filter({ hasText: label }),
  ];

  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) === 0) continue;
    const first = candidate.first();
    if (!(await first.isVisible().catch(() => false))) continue;
    await first.click();
    return true;
  }
  return clickVisibleControlByLabel(dialog, label);
}

async function clickVisibleControlByLabel(scope: ReturnType<Page["locator"]>, label: string | RegExp) {
  const controls = scope.locator(clickableTextSelector());
  const count = await controls.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 60); index += 1) {
    const control = controls.nth(index);
    const meta = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const input = element instanceof HTMLInputElement ? element : undefined;
      return {
        visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        innerText: element instanceof HTMLElement ? element.innerText.replace(/\s+/g, " ").trim() : "",
        aria: element.getAttribute("aria-label") ?? "",
        title: element.getAttribute("title") ?? "",
        value: input?.value ?? "",
      };
    }).catch(() => undefined);
    if (!meta?.visible) continue;
    const labels = [meta.innerText, meta.text, meta.aria, meta.title, meta.value].filter(Boolean);
    if (!labels.some((value) => matchesButtonLabel(value, label))) continue;
    await control.click({ timeout: 2500 }).catch(async () => control.click({ timeout: 2500, force: true }));
    return true;
  }
  return false;
}

function matchesButtonLabel(value: string, label: string | RegExp) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (typeof label === "string") return normalized === label;
  label.lastIndex = 0;
  return label.test(normalized);
}

async function clickFoodDialogFilter(page: Page, label: string) {
  const dialog = activeDialog(page);
  const exact = new RegExp(`^${escapeRegExp(label)}$`, "i");
  const candidates = [
    dialog.getByRole("tab", { name: exact }),
    dialog.getByRole("button", { name: exact }),
    dialog.locator(".gwt-TabBarItem,.gwt-Button,.gwt-ToggleButton,[role='tab'],button").filter({ hasText: exact }),
    dialog.locator("td,div,span").filter({ hasText: exact }),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 8); index += 1) {
      const item = candidate.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      await item.click().catch(() => undefined);
      await page.waitForTimeout(500);
      await waitForFoodDialogReady(page, 5000).catch(() => false);
      return true;
    }
  }

  const box = await foodDialogFilterClickBox(page, label);
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await waitForFoodDialogReady(page, 5000).catch(() => false);
  return true;
}

async function foodDialogFilterClickBox(page: Page, label: string) {
  return page.evaluate((label) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const expected = normalize(label).toLowerCase();
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const dialogs = Array.from(document.querySelectorAll(".pretty-dialog, [role='dialog'], .gwt-DialogBox, .popupContent"))
      .filter(isVisible);
    const root = dialogs.at(-1) ?? document.body;
    const candidates = Array.from(root.querySelectorAll("button,[role='tab'],.gwt-TabBarItem,.gwt-ToggleButton,td,div,span"))
      .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
      .map((element) => {
        const text = normalize(element.innerText || element.textContent || element.getAttribute("aria-label"));
        const rect = element.getBoundingClientRect();
        const tabLike = element.matches("button,[role='tab'],.gwt-TabBarItem,.gwt-ToggleButton")
          || Boolean(element.closest("[role='tablist'],.gwt-TabBar,.tab-bar,.tabs"));
        return {
          text,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          tabLike,
          area: rect.width * rect.height,
        };
      })
      .filter((candidate) => candidate.text.toLowerCase() === expected)
      .sort((a, b) => Number(b.tabLike) - Number(a.tabLike) || a.area - b.area || a.y - b.y);
    return candidates[0];
  }, label).catch(() => undefined);
}

async function searchCurrentFoodDialog(page: Page, query: string, limit: number) {
  await waitForFoodDialogReady(page, 8000);
  const searchBox = await foodSearchBox(page);
  if (!searchBox) {
    throw new Error("Food search input was not found after opening the Cronometer food dialog.");
  }

  const previousResults = await collectFoodSearchResults(page, Math.min(limit, 5)).catch(() => []);
  const previousKey = foodResultsKey(previousResults);
  const previousInputValue = await searchBox.inputValue().catch(() => "");
  await searchBox.click();
  await page.keyboard.press("Control+A").catch(() => undefined);
  await page.keyboard.type(query, { delay: 10 });
  await searchBox.fill(query).catch(() => undefined);
  await searchBox.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) return;
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, query).catch(() => undefined);
  await searchBox.press("Enter").catch(() => undefined);
  const searched = await clickDialogButton(page, /^SEARCH$/i);
  if (!searched) {
    await clickByText(page, /^SEARCH$/i);
  }
  await waitForFoodSearchSettle(page, previousKey, Math.min(limit, 5), 2600);

  const results = await collectFoodSearchResults(page, limit);
  const latestKey = foodResultsKey(results.slice(0, Math.min(limit, 5)));
  if (
    results.length > 0 &&
    latestKey === previousKey &&
    previousInputValue.trim().toLowerCase() !== query.trim().toLowerCase()
  ) {
    return [];
  }
  return results;
}

async function waitForFoodSearchSettle(page: Page, previousKey: string, limit: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  await page.waitForTimeout(350);
  let latestResults: SearchResult[] = [];

  while (Date.now() < deadline) {
    latestResults = await collectFoodSearchResults(page, limit).catch(() => latestResults);
    const latestKey = foodResultsKey(latestResults);
    if (latestResults.length > 0 && latestKey !== previousKey) return;

    const dialogText = await activeDialog(page).innerText({ timeout: 500 }).catch(() => "");
    if (/\b(no results|no foods found|did not match|nothing found)\b/i.test(dialogText)) return;
    await page.waitForTimeout(150);
  }
}

function foodResultsKey(results: SearchResult[]) {
  return results
    .map((result) => `${normalizeFoodName(result.name)}|${normalizeSource(result.source)}`)
    .join("\n");
}

async function foodSearchBox(page: Page) {
  return firstVisibleLocator(page, [
    activeDialog(page).getByPlaceholder(/Search all foods/i),
    activeDialog(page).getByPlaceholder(/Search/i),
    activeDialog(page).locator("input.gwt-TextBox.search-field:visible").last(),
    activeDialog(page).locator('input[type="text"]:visible').last(),
  ]);
}

async function clickFoodSearchResult(page: Page, selectedName: string, selectedSource?: string) {
  const dialog = activeDialog(page);
  const rows = dialog.locator("tr:visible");
  const count = await rows.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const parsed = parseFoodRowText(await row.innerText().catch(() => ""));
    if (!parsed) continue;
    if (normalizeFoodName(parsed.name) !== normalizeFoodName(selectedName)) continue;
    if (selectedSource && normalizeSource(parsed.source) !== normalizeSource(selectedSource)) continue;

    await row.scrollIntoViewIfNeeded().catch(() => undefined);
    await row.focus().catch(() => undefined);
    await row.click().catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    return true;
  }

  if (selectedSource) return false;

  const exactCell = dialog.locator(".gwt-HTML").filter({ hasText: new RegExp(`^${escapeRegExp(selectedName)}$`, "i") });
  if ((await exactCell.count().catch(() => 0)) > 0 && (await exactCell.first().isVisible().catch(() => false))) {
    await exactCell.first().click();
    return true;
  }

  const row = dialog.locator("tr").filter({ hasText: selectedName }).filter({ hasNotText: /^DescriptionSource$/i }).first();
  if ((await row.count().catch(() => 0)) > 0 && (await row.isVisible().catch(() => false))) {
    await row.click().catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    return true;
  }

  return false;
}

async function fillFoodAmount(page: Page, amount?: number) {
  if (amount === undefined) return { filled: true as const, skipped: true as const };
  const dialog = activeDialog(page);
  const textBoxes = dialog.locator("input.text-box:visible");
  const count = await textBoxes.count().catch(() => 0);
  if (count === 0) return { filled: false as const, warning: "No visible food amount input was found." };
  const input = textBoxes.nth(count - 1);
  const value = String(amount);
  await input.fill(value);
  const actualValue = await input.inputValue().catch(() => "");
  if (!numericInputMatches(actualValue, amount)) {
    return {
      filled: false as const,
      value,
      actualValue,
      warning: `Food amount did not verify after filling. Requested ${value}, current value is ${actualValue || "blank"}.`,
    };
  }
  return { filled: true as const, value, actualValue };
}

async function fillFoodTime(page: Page, timestamp?: string) {
  if (!timestamp) return;
  const parsed = parseTime(timestamp);
  if (!parsed) return;

  const dialog = activeDialog(page);
  const textBoxes = dialog.locator("input.text-box:visible");
  if ((await textBoxes.count().catch(() => 0)) < 2) return;

  await textBoxes.nth(0).fill(String(parsed.hour12));
  await textBoxes.nth(1).fill(String(parsed.minute).padStart(2, "0"));

  const periodButton = dialog.locator("button.dropdown-toggle:visible").filter({ hasText: /^(AM|PM)$/i }).first();
  if ((await periodButton.count().catch(() => 0)) === 0) return;
  const current = (await periodButton.innerText().catch(() => "")).trim().toUpperCase();
  if (current === parsed.period) return;
  await periodButton.click();
  await page.locator(".dropdown-item:visible").filter({ hasText: new RegExp(`^${parsed.period}$`, "i") }).last().click().catch(() => undefined);
}

async function fillFoodUnit(page: Page, unit?: string) {
  if (!unit) return { filled: true as const, skipped: true as const };
  const dialog = activeDialog(page);
  const normalizedUnit = unit.trim();
  const unitButton = dialog
    .locator("button.dropdown-toggle:visible")
    .filter({ hasText: /g|oz|serving|size|cup|tbsp|tsp|piece|slice|pint|pt|quart|ml|liter|litre/i })
    .last();
  if ((await unitButton.count().catch(() => 0)) === 0) {
    return { filled: false as const, unit: normalizedUnit, warning: "No visible food unit dropdown was found." };
  }
  const currentUnitText = await unitButton.innerText().catch(() => "");
  if (foodLogUnitTextMatches(currentUnitText, normalizedUnit)) {
    return { filled: true as const, unit: normalizedUnit, strategy: "already-selected" as const, currentUnitText };
  }
  await unitButton.click();
  const clicked = await clickExactFoodLogUnitOption(page, normalizedUnit);
  if (!clicked) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return {
      filled: false as const,
      unit: normalizedUnit,
      currentUnitText,
      warning: `Requested unit ${normalizedUnit} was not available as an exact serving unit. No food was written.`,
    };
  }
  const updatedUnitText = await waitForFoodLogUnitText(page, unitButton, normalizedUnit, 1800);
  if (!foodLogUnitTextMatches(updatedUnitText, normalizedUnit)) {
    return {
      filled: false as const,
      unit: normalizedUnit,
      strategy: "dropdown-option" as const,
      currentUnitText: updatedUnitText,
      warning: `Clicked a unit option, but the unit is still ${updatedUnitText || "unknown"}. No food was written.`,
    };
  }
  return { filled: true as const, unit: normalizedUnit, strategy: "dropdown-option" as const, currentUnitText: updatedUnitText };
}

async function waitForFoodLogUnitText(page: Page, unitButton: ReturnType<Page["locator"]>, unit: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let latest = await unitButton.innerText().catch(() => "");
  while (Date.now() < deadline) {
    latest = await unitButton.innerText().catch(() => latest);
    if (foodLogUnitTextMatches(latest, unit)) return latest;
    await page.waitForTimeout(150);
  }
  return latest;
}

async function clickExactFoodLogUnitOption(page: Page, unit: string) {
  const labels = [unit.trim().toLowerCase(), ...unitAliases(unit)];
  const labelPattern = labels.map(escapeRegExp).join("|");
  const exactPattern = new RegExp(`^\\s*(?:1(?:\\.0+)?\\s+)?(?:${labelPattern})\\s*$`, "i");
  const candidates = page
    .locator(".dropdown-item:visible,[role='option']:visible,.gwt-MenuItem:visible,li:visible,td:visible,button:visible")
    .filter({ hasText: exactPattern });
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = await candidate.innerText().catch(() => "");
    if (!foodLogUnitTextMatches(text, unit)) continue;
    await candidate.click().catch(async () => candidate.click({ force: true }));
    return true;
  }
  return false;
}

function foodLogUnitTextMatches(text: string, unit: string) {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const labels = [unit.trim().toLowerCase(), ...unitAliases(unit)];
  return labels.some((label) => normalized === label || normalized === `1 ${label}`);
}

async function fillLikelyAmount(page: Page, amount?: number, selectedName?: string) {
  if (amount === undefined) return { filled: true, skipped: true };
  const amountText = String(amount);
  const dialogText = await activeDialog(page).innerText({ timeout: 800 }).catch(() => "");
  const selectedPanel = await recipeIngredientSelectedPanel(page, selectedName);
  if (/\bDescription\s+Source\b/i.test(dialogText) && !selectedPanel) {
    return { filled: false, warning: "Still on ingredient search results; refused to fill the search box as an amount." };
  }
  const input = await editableAmountInput(page, 2500, selectedPanel);
  if (!input) {
    return { filled: false, warning: "No editable amount input was found; refused to fill radio/checkbox controls." };
  }
  const elementType = await input.evaluate((element) => element instanceof HTMLInputElement ? element.type : "").catch(() => "");
  if (/^(radio|checkbox|button|submit)$/i.test(elementType)) {
    return { filled: false, warning: `Refused to fill non-text ingredient amount input: ${elementType}.` };
  }
  await input.fill(amountText);
  await page.keyboard.press("Tab").catch(() => undefined);
  const actualValue = await input.inputValue().catch(() => "");
  if (!numericInputMatches(actualValue, amount)) {
    return {
      filled: false,
      value: amountText,
      actualValue,
      inputType: elementType || undefined,
      selectedPanel,
      warning: `Ingredient amount did not verify after filling. Requested ${amountText}, current value is ${actualValue || "blank"}.`,
    };
  }
  return { filled: true, value: amountText, actualValue, inputType: elementType || undefined, selectedPanel };
}

async function editableAmountInput(page: Page, timeoutMs: number, selectedPanel?: { x: number; y: number; width: number; height: number }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dialog = activeDialog(page);
    const input = await editableAmountInputInScope(dialog, selectedPanel) ?? await editableAmountInputInScope(page.locator("body"), selectedPanel);
    if (input) return input;
    await page.waitForTimeout(150);
  }
  return undefined;
}

async function editableAmountInputInScope(scope: ReturnType<Page["locator"]>, selectedPanel?: { x: number; y: number; width: number; height: number }) {
  const inputs = scope.locator("input:visible");
  const count = await inputs.count().catch(() => 0);
  const candidates: Array<{ input: ReturnType<Page["locator"]>; score: number }> = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const input = inputs.nth(index);
    const meta = await input.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) return undefined;
      const rect = element.getBoundingClientRect();
      return {
        type: element.type,
        readOnly: element.readOnly,
        disabled: element.disabled,
        placeholder: element.placeholder,
        className: String(element.className ?? ""),
        name: element.name,
        id: element.id,
        aria: element.getAttribute("aria-label") ?? "",
        value: element.value,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }).catch(() => undefined);
    if (!meta || meta.disabled || meta.readOnly) continue;
    if (!/^(text|number|tel|decimal|)$/i.test(meta.type)) continue;
    const haystack = `${meta.placeholder} ${meta.className} ${meta.name} ${meta.id} ${meta.aria}`.toLowerCase();
    if (/\b(search|filter|barcode)\b/.test(haystack)) continue;
    if (meta.className.includes("search-field")) continue;
    let score = 0;
    if (meta.type === "number" || /number-box/.test(meta.className)) score += 30;
    if (/\b(amount|serving|quantity|qty)\b/.test(haystack)) score += 20;
    if (selectedPanel) {
      const panelBottom = selectedPanel.y + selectedPanel.height;
      const verticalDistance = Math.abs(meta.y - panelBottom);
      const horizontallyNear = meta.x + meta.width >= selectedPanel.x - 80 && meta.x <= selectedPanel.x + selectedPanel.width + 260;
      if (meta.y >= selectedPanel.y - 20 && meta.y <= selectedPanel.y + 360) score += 30;
      if (horizontallyNear) score += 15;
      score -= Math.min(verticalDistance / 25, 20);
    }
    candidates.push({ input, score });
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.input;
}

function numericInputMatches(actualValue: string, expected: number) {
  const normalized = actualValue.replace(/,/g, "").trim();
  if (!normalized) return false;
  const actual = Number(normalized);
  if (!Number.isFinite(actual)) return normalized === String(expected);
  return Math.abs(actual - expected) <= Math.max(0.000001, Math.abs(expected) * 0.000001);
}

async function fillLikelyUnit(page: Page, unit?: string) {
  if (!unit) return { filled: true, skipped: true };
  const normalizedUnit = unit.trim();
  const selects = page.locator("select");
  const count = await selects.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    if (!(await select.isVisible().catch(() => false))) continue;
    const selected = await select.selectOption({ label: normalizedUnit }, { timeout: 700 }).then(() => true).catch(() => false);
    if (selected) return { filled: true, unit: normalizedUnit, strategy: "select-label" };
  }

  const dialog = activeDialog(page);
  const unitButton = await recipeUnitDropdownButton(page);
  if (!unitButton) return { filled: false, unit: normalizedUnit, warning: "No visible unit dropdown was found." };
  const currentUnitText = await unitButton.innerText().catch(() => "");
  if (unitTextAlreadyMatches(currentUnitText, normalizedUnit)) {
    return { filled: true, unit: normalizedUnit, strategy: "already-selected", currentUnitText };
  }

  await unitButton.click({ timeout: 2500 }).catch(async () => unitButton.click({ timeout: 2500, force: true }));
  await waitForVisibleUnitOptions(page, 1800);
  const clicked = await clickVisibleUnitOption(page, normalizedUnit)
    || await clickVisibleOptionByExactText(page, normalizedUnit)
    || await clickVisibleOptionByExactText(page, unitAliases(normalizedUnit)[0])
    || await clickVisibleControlByLabel(dialog, new RegExp(`^${escapeRegExp(normalizedUnit)}$`, "i"));
  if (clicked) {
    const updatedUnitText = await waitForUnitText(page, unitButton, normalizedUnit, 1800);
    if (unitTextAlreadyMatches(updatedUnitText, normalizedUnit)) {
      return { filled: true, unit: normalizedUnit, strategy: "dropdown-option", currentUnitText: updatedUnitText };
    }
    return { filled: false, unit: normalizedUnit, strategy: "dropdown-option", currentUnitText: updatedUnitText, warning: `Clicked a unit option, but the unit is still ${updatedUnitText || "unknown"}.` };
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  const updatedUnitText = await unitButton.innerText().catch(() => currentUnitText);
  return { filled: false, unit: normalizedUnit, currentUnitText: updatedUnitText, warning: `Could not select unit option: ${normalizedUnit}.` };
}

async function waitForVisibleUnitOptions(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await page
      .locator("[role='option']:visible,.dropdown-item:visible,.dropdown-menu:visible *,.popupContent:visible *,.gwt-PopupPanel:visible *")
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function waitForUnitText(page: Page, unitButton: ReturnType<Page["locator"]>, unit: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let latest = await unitButton.innerText().catch(() => "");
  while (Date.now() < deadline) {
    latest = await unitButton.innerText().catch(() => latest);
    if (unitTextAlreadyMatches(latest, unit)) return latest;
    await page.waitForTimeout(100);
  }
  return latest;
}

async function currentRecipeUnitText(page: Page) {
  const unitButton = await recipeUnitDropdownButton(page);
  return unitButton ? unitButton.innerText().catch(() => "") : "";
}

function unitTextAlreadyMatches(text: string, unit: string) {
  const normalizedText = text.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedUnit = unit.trim().toLowerCase();
  const labels = [normalizedUnit, ...unitAliases(normalizedUnit)];
  const withoutSingleServingPrefix = normalizedText.replace(/^1(?:\.0+)?\s+/, "");
  if (normalizedUnit === "g" && gramsPerServingUnit(normalizedText) === 1) return true;
  return labels.some((label) =>
    normalizedText === label ||
    normalizedText.startsWith(`${label} `) ||
    normalizedText.startsWith(`${label}—`) ||
    normalizedText.startsWith(`${label} —`) ||
    normalizedText.startsWith(`${label}-`) ||
    normalizedText.startsWith(`${label} -`) ||
    withoutSingleServingPrefix === label ||
    withoutSingleServingPrefix.startsWith(`${label} `) ||
    withoutSingleServingPrefix.startsWith(`${label}—`) ||
    withoutSingleServingPrefix.startsWith(`${label} —`) ||
    withoutSingleServingPrefix.startsWith(`${label}-`) ||
    withoutSingleServingPrefix.startsWith(`${label} -`)
  );
}

async function recipeUnitDropdownButton(page: Page) {
  const dialog = activeDialog(page);
  const buttons = dialog.locator("button.dropdown-toggle:visible, button.dropdown-btn:visible");
  const count = await buttons.count().catch(() => 0);
  let fallback: ReturnType<Page["locator"]> | undefined;
  for (let index = count - 1; index >= 0; index -= 1) {
    const button = buttons.nth(index);
    const meta = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      return {
        text,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }).catch(() => undefined);
    if (!meta || meta.width < 30 || meta.height < 20) continue;
    if (/\b(AM|PM|All|Custom|NCCDB|USDA|CRDB|Category|Source|Show score)\b/i.test(meta.text)) continue;
    if (/\b(g|gram|oz|lb|ml|cup|tbsp|tsp|large|small|medium|serving|pat|slice|piece)\b/i.test(meta.text)) return button;
    fallback ??= button;
  }
  return fallback;
}

async function clickVisibleOptionByExactText(page: Page, value?: string) {
  if (!value) return false;
  const normalizedValue = value.replace(/\s+/g, " ").trim().toLowerCase();
  const roleOption = page.getByRole("option", { name: new RegExp(`^${escapeRegExp(value)}$`, "i") }).last();
  if ((await roleOption.count().catch(() => 0)) > 0 && (await roleOption.isVisible().catch(() => false))) {
    return roleOption.click({ timeout: 1000 }).then(() => true).catch(() => false);
  }
  const box = await page.evaluate((normalizedValue) => {
    const normalize = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll(".dropdown-menu *,.popupContent *,.gwt-PopupPanel *,.select-popup *,.dropdown-item,li,button,div,td"))
      .filter(isVisible)
      .map((element) => {
        const text = normalize(element.textContent);
        const rect = element.getBoundingClientRect();
        return { text, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
      .filter((candidate) => candidate.text.toLowerCase() === normalizedValue)
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));
    return candidates[0];
  }, normalizedValue).catch(() => undefined);
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

async function clickVisibleUnitOption(page: Page, unit: string) {
  const normalizedUnit = unit.replace(/\s+/g, " ").trim().toLowerCase();
  const box = await page.evaluate((normalizedUnit) => {
    const normalize = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
    const aliases = (value: string) => {
      if (value === "g") return ["gram", "grams"];
      if (value === "oz") return ["ounce", "ounces"];
      if (value === "ml") return ["milliliter", "milliliters", "millilitre", "millilitres"];
      if (value === "tsp") return ["teaspoon", "teaspoons"];
      if (value === "tbsp") return ["tablespoon", "tablespoons", "tbs"];
      return [];
    };
    const gramsPerServingUnit = (text: string) => {
      const normalized = normalize(text).toLowerCase();
      const exact = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)$/i);
      if (exact?.[1]) return Number(exact[1]);
      const annotated = normalized.match(/[—-]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)\b/i)
        ?? normalized.match(/\(\s*([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)\s*\)/i)
        ?? normalized.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)\b/i);
      return annotated?.[1] ? Number(annotated[1]) : undefined;
    };
    const matches = (text: string, unit: string) => {
      const normalizedText = normalize(text).toLowerCase();
      const labels = [unit, ...aliases(unit)];
      const withoutSingleServingPrefix = normalizedText.replace(/^1(?:\.0+)?\s+/, "");
      if (unit === "g" && gramsPerServingUnit(normalizedText)) return true;
      return labels.some((label) =>
        normalizedText === label ||
        normalizedText.startsWith(`${label} `) ||
        normalizedText.startsWith(`${label}—`) ||
        normalizedText.startsWith(`${label} —`) ||
        normalizedText.startsWith(`${label}-`) ||
        normalizedText.startsWith(`${label} -`) ||
        withoutSingleServingPrefix === label ||
        withoutSingleServingPrefix.startsWith(`${label} `) ||
        withoutSingleServingPrefix.startsWith(`${label}—`) ||
        withoutSingleServingPrefix.startsWith(`${label} —`) ||
        withoutSingleServingPrefix.startsWith(`${label}-`) ||
        withoutSingleServingPrefix.startsWith(`${label} -`)
      );
    };
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll("[role='option'],.dropdown-item,.dropdown-menu *,.popupContent *,.gwt-PopupPanel *,.select-popup *,li,button,div,td"))
      .filter(isVisible)
      .map((element) => {
        const text = normalize(element.textContent);
        const rect = element.getBoundingClientRect();
        const gramWeight = normalizedUnit === "g" ? gramsPerServingUnit(text) : undefined;
        const exactText = text.toLowerCase() === normalizedUnit;
        const optionLike = element.matches("[role='option'],.dropdown-item,li,button,td")
          || Boolean(element.closest("[role='listbox'],[role='menu'],.dropdown-menu,.select-popup"));
        return { text, x: rect.x, y: rect.y, width: rect.width, height: rect.height, gramWeight, exactText, optionLike };
      })
      .filter((candidate) => candidate.text && matches(candidate.text, normalizedUnit) && (normalizedUnit !== "g" || candidate.optionLike || candidate.exactText))
      .sort((a, b) => {
        const score = (candidate: typeof a) => {
          let total = 0;
          if (candidate.exactText) total += 80;
          if (candidate.gramWeight === 1) total += 70;
          else if (candidate.gramWeight) total += 20;
          total -= Math.min(candidate.width * candidate.height / 1000, 30);
          return total;
        };
        return score(b) - score(a);
      });
    return candidates[0];
  }, normalizedUnit).catch(() => undefined);
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

function unitAliases(unit: string) {
  const normalized = unit.trim().toLowerCase();
  if (normalized === "g") return ["gram", "grams"];
  if (normalized === "oz") return ["ounce", "ounces"];
  if (normalized === "ml") return ["milliliter", "milliliters"];
  if (normalized === "tsp") return ["teaspoon", "teaspoons"];
  if (normalized === "tbsp") return ["tablespoon", "tablespoons", "tbs"];
  return [];
}

async function fillCustomFoodName(page: Page, name: string) {
  const nameInput = await customFoodNameInput(page);
  if (!nameInput) return false;
  await nameInput.click({ timeout: 2500 }).catch(() => undefined);
  await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
  await page.keyboard.type(name, { delay: 15 }).catch(() => undefined);
  await nameInput.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) return;
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, name).catch(() => undefined);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(550);
  const updatedValue = await nameInput.inputValue().catch(() => "");
  return updatedValue.trim() === name;
}

async function customFoodNameInput(page: Page) {
  const inputs = page.locator("#main-food-editor-info-area input.text-box:visible");
  const count = await inputs.count().catch(() => 0);
  let fallback: ReturnType<Page["locator"]> | undefined;

  for (let index = 0; index < Math.min(count, 12); index += 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;
    const value = (await input.inputValue().catch(() => "")).trim();
    if (/^New Food$/i.test(value)) return input;
    if (!fallback && value && !/^(Serving|g|gram|grams|n\/a)$/i.test(value) && !/^\d+(?:\.\d+)?$/.test(value)) {
      fallback = input;
    }
  }

  return fallback ?? firstVisibleLocator(page, [inputs.first()]);
}

async function openCustomFoodByName(page: Page, name: string) {
  const clicked = await clickByText(page, new RegExp(`^${escapeRegExp(name)}$`, "i"));
  if (!clicked) return false;
  await page.waitForTimeout(1200);
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return textHasFoodName(text, name) && /\b(Food Name|Nutrition Label|ADD TO DIARY)\b/i.test(text);
}

async function fillCustomFoodServing(page: Page, servingSize?: string) {
  const parsed = parseServingSize(servingSize);
  const result = {
    requested: servingSize,
    parsed,
    amountFilled: false,
    measureFilled: false,
    warning: undefined as string | undefined,
  };

  if (!parsed) {
    result.warning = servingSize ? "Could not parse servingSize. Expected values like '100 g'." : undefined;
    return result;
  }

  result.amountFilled = await fillServingSizeCell(page, 0, parsed.amountText);
  result.measureFilled = await fillServingSizeCell(page, 1, parsed.unit);

  const rowText = await servingSizeRowText(page);
  if (
    !result.amountFilled ||
    !result.measureFilled ||
    !servingSizeRowMatches(rowText, parsed.amountText, parsed.unit)
  ) {
    result.warning = "Could not verify Cronometer serving size row after editing.";
  }
  return result;
}

export function parseServingSize(value?: string) {
  const match = value?.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z][a-zA-Z ]{0,40}|µg|mcg|mL|ml|oz|fl oz)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = normalizeServingUnit(match[2] ?? "");
  if (!unit) return undefined;
  return { amount, amountText: match[1], unit };
}

export function normalizeServingUnit(unit: string) {
  const normalized = unit.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  const aliases: Record<string, string> = {
    gram: "g",
    grams: "g",
    milligram: "mg",
    milligrams: "mg",
    microgram: "mcg",
    micrograms: "mcg",
    ug: "mcg",
    "µg": "mcg",
    milliliter: "ml",
    milliliters: "ml",
    millilitre: "ml",
    millilitres: "ml",
    ounce: "oz",
    ounces: "oz",
    serving: "serving",
    servings: "serving",
  };
  return aliases[lower] ?? normalized;
}

export function servingSizeRowMatches(rowText: string, amountText: string, unit: string) {
  const normalized = rowText.replace(/\s+/g, " ").trim().toLowerCase();
  const amountMatches = new RegExp(`(^|\\D)${escapeRegExp(amountText)}(\\D|$)`).test(normalized);
  const unitLower = unit.toLowerCase();
  const unitAliases = [unitLower, ...servingUnitAliases(unitLower)];
  return amountMatches && unitAliases.some((alias) => new RegExp(`(^|\\W)${escapeRegExp(alias)}(\\W|$)`, "i").test(normalized));
}

export function servingUnitAliases(unit: string) {
  if (unit === "g") return ["gram", "grams"];
  if (unit === "mg") return ["milligram", "milligrams"];
  if (unit === "mcg") return ["microgram", "micrograms", "ug", "µg"];
  if (unit === "ml") return ["milliliter", "milliliters", "millilitre", "millilitres"];
  if (unit === "oz") return ["ounce", "ounces"];
  if (unit === "serving") return ["servings"];
  return [];
}

async function fillServingSizeCell(page: Page, cellIndex: number, value: string) {
  await scrollServingSizeRowIntoView(page);
  await page.waitForTimeout(250);
  const cellBox = await servingSizeCellBox(page, cellIndex);
  if (!cellBox) return false;
  await page.mouse.click(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
  await page.waitForTimeout(450);

  const editor = await firstVisibleLocator(page, [
    page.locator("#main-food-editor-info-area input.number-box:focus").first(),
    page.locator("#main-food-editor-info-area input.text-box:focus").first(),
    page.locator("#main-food-editor-info-area input.number-box:visible").last(),
    page.locator("#main-food-editor-info-area input.text-box:visible").last(),
  ]);
  if (!editor) return false;
  const filled = await editor.fill(value).then(() => true).catch(() => false);
  if (!filled) return false;
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(500);

  const rowText = await servingSizeRowText(page);
  return rowText.toLowerCase().includes(value.toLowerCase());
}

async function scrollServingSizeRowIntoView(page: Page) {
  await page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll("#main-food-editor-info-area table.crono-table tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      const rowText = normalize(row.textContent);
      if (cells.length >= 3 && !row.classList.contains("table-header") && /^\d+(?:\.\d+)?\s+\S+/.test(rowText)) {
        row.scrollIntoView({ block: "center" });
        return;
      }
    }
  }).catch(() => undefined);
}

async function servingSizeCellBox(page: Page, cellIndex: number) {
  return page.evaluate((cellIndex) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll("#main-food-editor-info-area table.crono-table tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      const rowText = normalize(row.textContent);
      if (cells.length >= 3 && !row.classList.contains("table-header") && /^\d+(?:\.\d+)?\s+\S+/.test(rowText)) {
        const rect = (cells[cellIndex] ?? cells[0])?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    return undefined;
  }, cellIndex);
}

async function servingSizeRowText(page: Page) {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll("#main-food-editor-info-area table.crono-table tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      const rowText = normalize(row.textContent);
      if (cells.length >= 3 && !row.classList.contains("table-header") && /^\d+(?:\.\d+)?\s+\S+/.test(rowText)) {
        return rowText;
      }
    }
    return "";
  }).catch(() => "");
}

async function fillCustomFoodNutrients(page: Page, nutrients: Record<string, number>) {
  const entries = customFoodNutrientEntries(nutrients);
  const results = [];
  for (const entry of entries) {
    const filled = await fillCustomFoodNutrient(page, entry.label, entry.value);
    results.push({ ...entry, ...filled });
  }
  return results;
}

export function customFoodNutrientEntries(nutrients: Record<string, number>) {
  const mapped = new Map<string, { label: string; value: number; sourceKey: string }>();
  for (const [key, value] of Object.entries(nutrients)) {
    if (!Number.isFinite(value)) continue;
    const label = customFoodNutrientLabelForKey(key);
    if (!label) continue;
    mapped.set(label, { label, value, sourceKey: key });
  }
  return Array.from(mapped.values());
}

export function customFoodWritePreview(input: { servingSize?: string; nutrients?: Record<string, number> }) {
  const parsedServingSize = parseServingSize(input.servingSize);
  const nutrientEntries = customFoodNutrientEntries(input.nutrients ?? {});
  const ignoredNutrients = Object.entries(input.nutrients ?? {})
    .filter(([, value]) => !Number.isFinite(value))
    .map(([sourceKey, value]) => ({
      sourceKey,
      value: Number.isNaN(value) ? "NaN" : String(value),
    }));
  return {
    servingSize: {
      requested: input.servingSize,
      parsed: parsedServingSize,
      warning: input.servingSize && !parsedServingSize
        ? "Could not parse servingSize. Use values like '100 g', '1 serving', '250 ml', or '1 oz'."
        : undefined,
    },
    nutrients: nutrientEntries,
    ignoredNutrients,
    nutrientCount: nutrientEntries.length,
  };
}

async function fillCustomFoodNutrient(page: Page, label: string, value: number) {
  await scrollNutrientRowIntoView(page, label);
  await page.waitForTimeout(60);
  const cellBox = await nutrientAmountCellBox(page, label);
  if (!cellBox) {
    const fallback = await fillNutritionLabelNutrient(page, label, value);
    if (fallback) return fallback;
    return { status: "not_found" as const, warning: `Could not find nutrient row: ${label}` };
  }

  const clickedCellBox = await clickNutrientAmountCell(page, label);
  if (!clickedCellBox) {
    await page.mouse.click(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
  }
  const fastFill = await fillFocusedCellInput(page, clickedCellBox ?? cellBox, value);
  if (fastFill) return fastFill;
  await page.waitForTimeout(100);

  const inputCountsBeforeClick = await visibleInputCounts(page, ["input.number-box:visible"]);
  const input = await focusedOrNearestInput(page, clickedCellBox ?? cellBox, ["input.number-box:visible"])
    ?? await newestVisibleInputIfAdded(page, ["input.number-box:visible"], inputCountsBeforeClick);
  if (!input) {
    const fallback = await fillNutritionLabelNutrient(page, label, value);
    if (fallback) return fallback;
    return { status: "not_found" as const, warning: `No editable amount input appeared for ${label}.` };
  }

  await input.fill(String(value));
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(120);

  const rowText = await nutrientRowText(page, label);
  const verified = rowTextIncludesValue(rowText, value);
  return {
    status: verified ? ("ok" as const) : ("unverified" as const),
    rowText,
    warning: verified ? undefined : `Filled ${label}, but the updated row text could not be verified.`,
  };
}

async function fillNutritionLabelNutrient(page: Page, label: string, value: number) {
  const nutritionLabel = customFoodNutritionLabel(label);
  if (!nutritionLabel) return undefined;

  const cellBox = await nutritionLabelAmountCellBox(page, nutritionLabel);
  if (!cellBox) {
    return { status: "not_found" as const, warning: `Could not find nutrition label amount for ${nutritionLabel}.` };
  }

  const selectors = ["input.number-box:visible", "input.text-box:visible"];
  await page.mouse.click(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
  const fastFill = await fillFocusedCellInput(page, cellBox, value);
  if (fastFill) return {
    ...fastFill,
    source: "nutrition_label" as const,
  };
  await page.waitForTimeout(100);
  const inputCountsBeforeClick = await visibleInputCounts(page, selectors);
  const input = await focusedOrNearestInput(page, cellBox, selectors)
    ?? await newestVisibleInputIfAdded(page, selectors, inputCountsBeforeClick);
  if (!input) {
    return { status: "not_found" as const, warning: `No editable nutrition label input appeared for ${nutritionLabel}.` };
  }

  const filled = await input.fill(String(value)).then(() => true).catch(() => false);
  if (!filled) {
    return { status: "not_found" as const, warning: `Could not fill nutrition label input for ${nutritionLabel}.` };
  }
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(120);

  const labelText = await nutritionLabelText(page, nutritionLabel);
  const verified = rowTextIncludesValue(labelText, value);
  return {
    status: verified ? ("ok" as const) : ("unverified" as const),
    rowText: labelText,
    source: "nutrition_label" as const,
    warning: verified ? undefined : `Filled ${nutritionLabel}, but the updated nutrition label text could not be verified.`,
  };
}

async function fillFocusedCellInput(page: Page, box: { x: number; y: number; width: number; height: number }, value: number) {
  await page.waitForTimeout(35);
  const focusedIsNearCell = await page.evaluate((box) => {
    const element = document.activeElement;
    if (!(element instanceof HTMLInputElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const inputCenter = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const boxCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    return Math.hypot(inputCenter.x - boxCenter.x, inputCenter.y - boxCenter.y) <= 240;
  }, box).catch(() => false);
  if (!focusedIsNearCell) return undefined;

  const input = page.locator("input.number-box:focus, input.text-box:focus").first();
  const filled = await input.fill(String(value), { timeout: 800 }).then(() => true).catch(() => false);
  if (!filled) return undefined;
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(35);
  return {
    status: "filled" as const,
    verification: "skipped_for_speed" as const,
  };
}

function customFoodNutritionLabel(label: string) {
  const labels: Record<string, string> = {
    Energy: "Calories",
    Sodium: "Sodium",
    Protein: "Protein",
  };
  return labels[label];
}

async function focusedOrNearestInput(page: Page, box: { x: number; y: number; width: number; height: number }, selectors: string[]) {
  const focused = await firstVisibleLocator(page, [
    page.locator("input.number-box:focus").first(),
    page.locator("input.text-box:focus").first(),
  ]);
  if (focused) return focused;

  const boxCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  let best: { selector: string; index: number; distance: number } | undefined;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const candidateBox = await candidate.boundingBox().catch(() => undefined);
      if (!candidateBox) continue;
      const candidateCenter = {
        x: candidateBox.x + candidateBox.width / 2,
        y: candidateBox.y + candidateBox.height / 2,
      };
      const distance = Math.hypot(candidateCenter.x - boxCenter.x, candidateCenter.y - boxCenter.y);
      if (distance > 220) continue;
      if (!best || distance < best.distance) best = { selector, index, distance };
    }
  }
  return best ? page.locator(best.selector).nth(best.index) : undefined;
}

async function visibleInputCounts(page: Page, selectors: string[]) {
  const counts = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    let visibleCount = 0;
    for (let index = 0; index < Math.min(count, 30); index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) visibleCount += 1;
    }
    counts.push(visibleCount);
  }
  return counts;
}

async function newestVisibleInputIfAdded(page: Page, selectors: string[], beforeCounts: number[]) {
  for (const [selectorIndex, selector] of selectors.entries()) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    const beforeCount = beforeCounts[selectorIndex] ?? 0;
    if (count <= beforeCount) continue;
    for (let index = count - 1; index >= beforeCount; index -= 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return undefined;
}

async function nutritionLabelAmountCellBox(page: Page, label: string) {
  return page.evaluate((label) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const rectJson = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    const elements = Array.from(document.querySelectorAll("body *")).filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element));
    const labelElements = elements.filter((element) => normalize(element.innerText || element.textContent) === label);

    for (const labelElement of labelElements) {
      const labelRect = labelElement.getBoundingClientRect();
      const ancestors: HTMLElement[] = [];
      let current: HTMLElement | null = labelElement;
      while (current && current !== document.body) {
        ancestors.push(current);
        current = current.parentElement;
      }

      for (const ancestor of ancestors.slice(0, 6)) {
        const text = normalize(ancestor.textContent);
        if (!text.includes(label) || text.length > 600) continue;
        const candidates = Array.from(ancestor.querySelectorAll("*"))
          .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const elementText = normalize(element.innerText || element.textContent);
            const smallAmountText = /^(?:-|[0-9]+(?:\.[0-9]+)?)(?:\s*(?:kcal|g|mg|mcg|%))?$/i.test(elementText);
            const horizontallyNear = rect.left >= labelRect.left - 8 && rect.left <= labelRect.right + 240;
            const verticallyNear = Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2)) <= 70;
            if (!smallAmountText || !horizontallyNear || !verticallyNear) return undefined;
            return { rect, distance: Math.abs(rect.left - labelRect.right) + Math.abs(rect.top - labelRect.top), text: elementText };
          })
          .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
          .sort((a, b) => a.distance - b.distance);
        if (candidates[0]) return rectJson(candidates[0].rect);
      }

      return {
        x: Math.min(Math.max(labelRect.right + 28, labelRect.left + 20), window.innerWidth - 30),
        y: labelRect.y + labelRect.height / 2,
        width: 24,
        height: Math.max(labelRect.height, 18),
      };
    }
    return undefined;
  }, label);
}

async function nutritionLabelText(page: Page, label: string) {
  return page.evaluate((label) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const elements = Array.from(document.querySelectorAll("body *")).filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element));
    const labelElement = elements.find((element) => normalize(element.innerText || element.textContent) === label);
    let current: HTMLElement | null | undefined = labelElement;
    while (current && current !== document.body) {
      const text = normalize(current.textContent);
      if (text.includes(label) && text.length <= 600) return text;
      current = current.parentElement;
    }
    return "";
  }, label).catch(() => "");
}

async function scrollNutrientRowIntoView(page: Page, label: string) {
  await page.evaluate((label) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
    const isHeader = (cells: Element[]) => normalize(cells[1]?.textContent).toLowerCase() === "amount";
    const expected = normalize(label).toLowerCase();
    const rows = Array.from(document.querySelectorAll(".food-editor-nutrition-summary table.crono-table tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 3 || normalize(cells[0]?.textContent).toLowerCase() !== expected) continue;
      if (isHeader(cells)) continue;
      const rect = (cells[1] ?? cells[0]).getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      {
        row.scrollIntoView({ block: "center" });
        return;
      }
    }
  }, label).catch(() => undefined);
}

async function nutrientAmountCellBox(page: Page, label: string) {
  return page.evaluate((label) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
    const isHeader = (cells: Element[]) => normalize(cells[1]?.textContent).toLowerCase() === "amount";
    const expected = normalize(label).toLowerCase();
    const rows = Array.from(document.querySelectorAll(".food-editor-nutrition-summary table.crono-table tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 3 || normalize(cells[0]?.textContent).toLowerCase() !== expected) continue;
      if (isHeader(cells)) continue;
      const target = cells[1] ?? cells[0];
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    return undefined;
  }, label);
}

async function clickNutrientAmountCell(page: Page, label: string) {
  return page.evaluate((label) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
    const isHeader = (cells: Element[]) => normalize(cells[1]?.textContent).toLowerCase() === "amount";
    const expected = normalize(label).toLowerCase();
    const rows = Array.from(document.querySelectorAll(".food-editor-nutrition-summary table.crono-table tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 3 || normalize(cells[0]?.textContent).toLowerCase() !== expected) continue;
      if (isHeader(cells)) continue;
      const target = cells[1] ?? cells[0];
      target.scrollIntoView({ block: "center" });
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      for (const type of ["mousedown", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
        }));
      }
      const nextRect = target.getBoundingClientRect();
      return { x: nextRect.x, y: nextRect.y, width: nextRect.width, height: nextRect.height };
    }
    return undefined;
  }, label).catch(() => undefined);
}

async function nutrientRowText(page: Page, label: string) {
  return page.evaluate((label) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
    const isHeader = (cells: Element[]) => normalize(cells[1]?.textContent).toLowerCase() === "amount";
    const expected = normalize(label).toLowerCase();
    const rows = Array.from(document.querySelectorAll(".food-editor-nutrition-summary table.crono-table tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 3 || normalize(cells[0]?.textContent).toLowerCase() !== expected) continue;
      if (isHeader(cells)) continue;
      return normalize(row.textContent);
    }
    return "";
  }, label).catch(() => "");
}

function rowTextIncludesValue(rowText: string, value: number) {
  const normalized = rowText.replace(/,/g, "");
  const valueText = String(value);
  if (new RegExp(`(^|\\D)${escapeRegExp(valueText)}(\\D|$)`).test(normalized)) return true;
  return normalized.includes(String(Number(value.toFixed(4))));
}

function textHasFoodName(text: string, name: string) {
  return text.toLowerCase().includes(name.toLowerCase());
}

type CustomFoodTraceEntry = { step: string; elapsedMs: number; details: Record<string, unknown> };
type RecipeTrace = (step: string, details?: Record<string, unknown>) => void;
type RecipeTraceEntry = { step: string; elapsedMs: number; details: Record<string, unknown> };

function logCustomFoodStep(foodName: string, startedAt: number, step: string, details: Record<string, unknown> = {}, entries?: CustomFoodTraceEntry[]) {
  const elapsedMs = Date.now() - startedAt;
  entries?.push({ step, elapsedMs, details });
  if (entries && entries.length > 50) entries.splice(0, entries.length - 50);
  try {
    console.log(JSON.stringify({
      feature: "create_custom_food",
      foodName,
      step,
      elapsedMs,
      ...details,
    }));
  } catch {
    // Logging must never affect Cronometer writes.
  }
}

function summarizeFillResults(results: Array<{ status?: string; warning?: string }>) {
  const counts = new Map<string, number>();
  let warningCount = 0;
  for (const result of results) {
    counts.set(result.status ?? "unknown", (counts.get(result.status ?? "unknown") ?? 0) + 1);
    if (result.warning) warningCount += 1;
  }
  return {
    total: results.length,
    warningCount,
    statuses: Object.fromEntries(counts.entries()),
  };
}

function logRecipeStep(recipeName: string, startedAt: number, step: string, details: Record<string, unknown> = {}, entries?: RecipeTraceEntry[]) {
  const elapsedMs = Date.now() - startedAt;
  entries?.push({ step, elapsedMs, details });
  if (entries && entries.length > 80) entries.splice(0, entries.length - 80);
  try {
    console.log(JSON.stringify({
      feature: "create_recipe",
      recipeName,
      step,
      elapsedMs,
      ...details,
    }));
  } catch {
    // Logging must never affect Cronometer writes.
  }
}

function parseCustomItemListNames(rawText: string, sectionTitle: string) {
  const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const startIndex = Math.max(
    lines.findIndex((line) => /^Sorted by/i.test(line)),
    lines.findIndex((line) => line === sectionTitle),
  );
  const navAndAction = /^(menu|Dashboard|Diary|Trends|Foods|Custom Meals|Custom Recipes|Custom Foods|Repeat Items|Suggest Food|Ask the Oracle|Search Foods|More|Plans|Support|About|Account|campaign|CREATE FOOD|CREATE RECIPE|IMPORT RECIPE|BACK TO FOODS LIST|BACK TO RECIPE LIST|Create a new food|Create a new recipe|Sorted by)/i;
  return lines
    .slice(Math.max(0, startIndex + 1))
    .filter((line) => !navAndAction.test(line))
    .filter((line) => !isCustomItemEmptyStateLine(line))
    .filter((line) => !/^(Food #\d+|Recipe #\d+|Data Source:|Info|Serving Sizes|Nutrition Label|Nutrition Facts|ADD TO DIARY|more_horiz)$/i.test(line))
    .slice(0, 120);
}

function isCustomItemEmptyStateLine(line: string) {
  return /^Create a custom (food|recipe|meal) using the button above\.?$/i.test(line)
    || /^Create your own recipe or import a recipe from a website using the buttons above\.?$/i.test(line)
    || /^No custom (foods|recipes|meals)(?: found)?\.?$/i.test(line)
    || /^You have no custom (foods|recipes|meals)\.?$/i.test(line);
}

function filterCustomItemNames(names: string[], query?: string) {
  const normalizedQuery = query?.trim().toLowerCase();
  const filtered = normalizedQuery ? names.filter((name) => name.toLowerCase().includes(normalizedQuery)) : names;
  return filtered.filter(Boolean);
}

function duplicateGroups(names: string[]) {
  const grouped = new Map<string, string[]>();
  for (const name of names) {
    const key = name.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), name]);
  }
  return Array.from(grouped.entries())
    .filter(([, values]) => values.length > 1)
    .map(([normalizedName, values]) => ({ normalizedName, count: values.length, names: values }));
}

async function customFoodDetailsForNames(page: Page, names: string[], maxDetails: number) {
  const details: CustomFoodDetail[] = [];
  const occurrences = new Map<string, number>();
  const limitedNames = names.slice(0, maxDetails);
  for (const [listIndex, name] of limitedNames.entries()) {
    const normalized = name.toLowerCase();
    const occurrence = occurrences.get(normalized) ?? 0;
    occurrences.set(normalized, occurrence + 1);
    await page.goto(`${CRONOMETER_ORIGIN}/#custom-foods`);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(900);
    const clicked = await clickCustomListItemByName(page, name, occurrence);
    if (!clicked) {
      continue;
    }
    await page.waitForTimeout(1000);
    const detail = await extractCustomFoodDetail(page);
    details.push({ ...(detail ?? { name }), name: detail?.name ?? name, listIndex, occurrence });
  }
  await page.goto(`${CRONOMETER_ORIGIN}/#custom-foods`).catch(() => undefined);
  await page.waitForTimeout(700).catch(() => undefined);
  return details;
}

async function resolveCustomFoodTargets(
  page: Page,
  selector: CustomFoodSelectorInput,
  options: { maxDetails: number; timeoutMs?: number; lightweightExactName?: boolean },
) {
  const rawText = await waitForCustomItemListText(page, "Custom Foods", options.timeoutMs ?? 12000);
  const names = parseCustomItemListNames(rawText, "Custom Foods");
  const query = selector.name;
  const matchingNames = query ? exactOrFuzzyCustomItemNames(names, query) : names;
  if (query && matchingNames.length === 0 && !selector.foodId) {
    return { names, targets: [] };
  }
  if (query && options.lightweightExactName && !selector.foodId) {
    const lightweightTargets = exactCustomItemTargets(names, query);
    if (lightweightTargets.length === 1) {
      return { names, targets: lightweightTargets };
    }
  }
  const candidateNames = query && matchingNames.length === 0 ? [query] : matchingNames;
  const details = await customFoodDetailsForNames(page, candidateNames, options.maxDetails);
  const targets = details.filter((detail) => {
    if (selector.foodId && detail.foodId && detail.foodId !== selector.foodId) return false;
    if (selector.foodId && !detail.foodId && (!selector.name || detail.name.toLowerCase() !== selector.name.toLowerCase())) return false;
    if (selector.name && detail.name.toLowerCase() !== selector.name.toLowerCase()) return false;
    return Boolean(selector.foodId || selector.name);
  });
  if (targets.length === 0 && query) {
    const exactVisibleTargets = exactCustomItemTargets(names, query);
    if (exactVisibleTargets.length === 1) {
      return {
        names,
        targets: exactVisibleTargets.map((target) => ({ ...target, foodId: selector.foodId })),
      };
    }
  }
  return { names, targets };
}

async function customRecipeDetailsForNames(page: Page, names: string[], maxDetails: number) {
  const details: CustomRecipeDetail[] = [];
  const occurrences = new Map<string, number>();
  const limitedNames = names.slice(0, maxDetails);
  for (const [listIndex, name] of limitedNames.entries()) {
    const normalized = name.toLowerCase();
    const occurrence = occurrences.get(normalized) ?? 0;
    occurrences.set(normalized, occurrence + 1);
    await page.goto(`${CRONOMETER_ORIGIN}/#custom-recipes`);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await waitForCustomItemListText(page, "Custom Recipes", 12000).catch(() => "");
    const clicked = await clickCustomListItemByName(page, name, occurrence);
    if (!clicked) continue;
    await page.waitForTimeout(1000);
    const detail = await extractCustomRecipeDetail(page);
    details.push({ ...(detail ?? { name }), name: detail?.name ?? name, listIndex, occurrence });
  }
  await page.goto(`${CRONOMETER_ORIGIN}/#custom-recipes`).catch(() => undefined);
  await page.waitForTimeout(700).catch(() => undefined);
  return details;
}

async function resolveCustomRecipeTargets(page: Page, selector: CustomRecipeSelectorInput, options: { maxDetails: number; timeoutMs?: number }) {
  const rawText = await waitForCustomItemListText(page, "Custom Recipes", options.timeoutMs ?? 12000);
  const names = parseCustomItemListNames(rawText, "Custom Recipes");
  const query = selector.name;
  const matchingNames = query ? exactOrFuzzyCustomItemNames(names, query) : names;
  const candidateNames = query && matchingNames.length === 0 ? [query] : matchingNames;
  const details = await customRecipeDetailsForNames(page, candidateNames, options.maxDetails);
  const targets = details.filter((detail) => {
    if (selector.recipeId && detail.recipeId !== selector.recipeId) return false;
    if (selector.name && detail.name.toLowerCase() !== selector.name.toLowerCase()) return false;
    return Boolean(selector.recipeId || selector.name);
  });
  return { names, targets };
}

async function customRecipeExistsInList(page: Page, name: string, timeoutMs: number) {
  await page.goto(`${CRONOMETER_ORIGIN}/#custom-recipes`).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  const rawText = await waitForCustomItemListText(page, "Custom Recipes", timeoutMs);
  return parseCustomItemListNames(rawText, "Custom Recipes").some((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

function exactOrFuzzyCustomItemNames(names: string[], query: string) {
  const normalizedQuery = query.toLowerCase();
  const exact = names.filter((name) => name.toLowerCase() === normalizedQuery);
  return exact.length ? exact : names.filter((name) => name.toLowerCase().includes(normalizedQuery));
}

function exactCustomItemTargets(names: string[], query: string): CustomFoodDetail[] {
  const normalizedQuery = query.toLowerCase();
  const occurrences = new Map<string, number>();
  const targets: CustomFoodDetail[] = [];

  names.forEach((name, listIndex) => {
    const normalizedName = name.toLowerCase();
    const occurrence = occurrences.get(normalizedName) ?? 0;
    occurrences.set(normalizedName, occurrence + 1);
    if (normalizedName === normalizedQuery) {
      targets.push({ name, listIndex, occurrence });
    }
  });

  return targets;
}

async function openCustomFoodTarget(page: Page, target: CustomFoodDetail) {
  await page.goto(`${CRONOMETER_ORIGIN}/#custom-foods`);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await waitForCustomItemListText(page, "Custom Foods", 12000).catch(() => "");
  const clicked = await clickCustomListItemByName(page, target.name, target.occurrence ?? 0);
  if (!clicked) return false;
  await waitForVisibleText(page, (text) =>
    textHasFoodName(text, target.name) && /\b(BACK TO FOODS LIST|Nutrition Label|Food Name|ADD TO DIARY)\b/i.test(text),
    5000,
  ).catch(() => undefined);
  if (!target.foodId) return true;
  const detail = await extractCustomFoodDetail(page);
  if (!detail?.foodId && textHasFoodName(await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""), target.name)) return true;
  return detail?.foodId === target.foodId;
}

async function openCustomRecipeTarget(page: Page, target: CustomRecipeDetail) {
  await page.goto(`${CRONOMETER_ORIGIN}/#custom-recipes`);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await waitForCustomItemListText(page, "Custom Recipes", 12000).catch(() => "");
  const clicked = await clickCustomListItemByName(page, target.name, target.occurrence ?? 0);
  if (!clicked) return false;
  await page.waitForTimeout(1000);
  if (!target.recipeId) return true;
  const detail = await extractCustomRecipeDetail(page);
  return detail?.recipeId === target.recipeId;
}

async function clickCustomListItemByName(page: Page, name: string, occurrence: number) {
  const roleButton = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(name)}$`, "i") });
  const roleButtonCount = await roleButton.count().catch(() => 0);
  if (roleButtonCount > 0) {
    const button = roleButton.nth(Math.min(occurrence, roleButtonCount - 1));
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 2500 }).catch(async () => {
        const box = await button.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      return true;
    }
  }

  const box = await page.evaluate(({ name, occurrence }) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const normalizedName = normalize(name);
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const depth = (element: Element) => {
      let total = 0;
      let current: Element | null = element;
      while (current) {
        total += 1;
        current = current.parentElement;
      }
      return total;
    };
    const textMatches = (element: HTMLElement) => {
      const innerText = normalize(element.innerText || element.textContent);
      if (innerText === normalizedName) return { exact: true, line: true };
      const lines = (element.innerText || element.textContent || "").split(/\n+/).map(normalize).filter(Boolean);
      return { exact: false, line: lines.includes(normalizedName) };
    };
    const clickableAncestor = (element: HTMLElement) => {
      let current: HTMLElement | null = element;
      while (current && current !== document.body) {
        if (
          current.matches("button,a,[role='button'],[role='link'],li,tr,.list-item,.food-list-item,.ReactVirtualized__Table__row,.ag-row")
          || current.onclick
        ) return current;
        current = current.parentElement;
      }
      return element;
    };
    const candidates = Array.from(document.querySelectorAll("body *"))
      .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
      .map((element) => ({ element, match: textMatches(element) }))
      .filter((candidate) => candidate.match.exact || candidate.match.line)
      .map((candidate) => {
        const element = clickableAncestor(candidate.element);
        return {
          element,
          rect: element.getBoundingClientRect(),
          depth: depth(element),
          exact: candidate.match.exact,
          area: element.getBoundingClientRect().width * element.getBoundingClientRect().height,
        };
      })
      .filter((candidate) => candidate.rect.y > 120)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || a.area - b.area || b.depth - a.depth || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const target = candidates[occurrence]?.element ?? candidates[0]?.element;
    if (!target) return undefined;
    target.scrollIntoView({ block: "center" });
    const rect = target.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, { name, occurrence }).catch(() => undefined);
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

async function waitForCustomItemListText(page: Page, sectionTitle: string, timeoutMs: number) {
  const hash = sectionTitle === "Custom Foods" ? "#custom-foods" : "#custom-recipes";
  const backPattern = sectionTitle === "Custom Foods" ? /^BACK TO FOODS LIST$/i : /^BACK TO RECIPE LIST$/i;
  const hasBackLink = (value: string) => sectionTitle === "Custom Foods" ? /BACK TO FOODS LIST/i.test(value) : /BACK TO RECIPE LIST/i.test(value);
  let text = await waitForVisibleText(page, (value) => customItemTextIsReady(value, sectionTitle), Math.min(timeoutMs, 14000));

  if (!/Sorted by/i.test(text) && hasBackLink(text)) {
    await clickByText(page, backPattern).catch(() => false);
    await page.waitForTimeout(900);
    text = await waitForVisibleText(page, (value) => customItemTextIsReady(value, sectionTitle), Math.min(timeoutMs, 14000));
  }

  if (!/Sorted by/i.test(text)) {
    await page.goto(`${CRONOMETER_ORIGIN}/${hash}`).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(900);
    text = await waitForVisibleText(page, (value) => customItemTextIsReady(value, sectionTitle), Math.min(timeoutMs, 14000));
    if (!/Sorted by/i.test(text) && hasBackLink(text)) {
      await clickByText(page, backPattern).catch(() => false);
      await page.waitForTimeout(900);
      text = await waitForVisibleText(page, (value) => customItemTextIsReady(value, sectionTitle), Math.min(timeoutMs, 14000));
    }
  }

  return text;
}

function customItemTextIsReady(text: string, sectionTitle: string) {
  if (!new RegExp(`\\b${escapeRegExp(sectionTitle)}\\b`, "i").test(text)) return false;
  return /Sorted by/i.test(text);
}

async function extractCustomFoodDetail(page: Page): Promise<CustomFoodDetail | undefined> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
    const numberFromText = (value: string | null | undefined) => {
      const match = normalize(value).match(/-?[0-9]+(?:\.[0-9]+)?/);
      return match ? Number(match[0]) : undefined;
    };
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const bodyText = normalize(document.body.innerText);
    const foodId = bodyText.match(/Food\s+#(\d+)/i)?.[1];
    const nameInput = Array.from(document.querySelectorAll("#main-food-editor-info-area input.text-box"))
      .find((element): element is HTMLInputElement => element instanceof HTMLInputElement && isVisible(element) && Boolean(normalize(element.value)));
    const titleName = bodyText.match(/BACK TO FOODS LIST\s+(.+?)\s+(?:ADD TO DIARY|more_horiz|Food #)/i)?.[1];
    const name = normalize(nameInput?.value || titleName || "");
    if (!name) return undefined;

    let servingSize: string | undefined;
    const servingRows = Array.from(document.querySelectorAll("#main-food-editor-info-area table.crono-table tr"));
    for (const row of servingRows) {
      const cells = Array.from(row.querySelectorAll("td"));
      const rowText = normalize(row.textContent);
      if (cells.length >= 3 && !row.classList.contains("table-header") && /^\d+(?:\.\d+)?\s+\S+/.test(rowText)) {
        servingSize = `${normalize(cells[0]?.textContent)} ${normalize(cells[1]?.textContent)}`;
        break;
      }
    }

    const nutrients: Record<string, { value: number; unit: string; percentDailyValue?: number }> = {};
    const rows = Array.from(document.querySelectorAll(".food-editor-nutrition-summary table.crono-table tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 3) continue;
      const label = normalize(cells[0]?.textContent);
      const amountText = normalize(cells[1]?.textContent);
      const unit = normalize(cells[2]?.textContent);
      if (!label || amountText.toLowerCase() === "amount" || amountText === "-") continue;
      const value = numberFromText(amountText);
      if (value === undefined || !Number.isFinite(value)) continue;
      const percentDailyValue = numberFromText(cells[3]?.textContent);
      nutrients[label] = { value, unit, percentDailyValue };
    }

    const macros: Record<string, { value: number; unit: string }> = {};
    for (const label of ["Protein", "Total Carbs", "Fat", "Sugars", "Added Sugars", "Sugar Alcohol", "Allulose", "Fiber", "Sodium"]) {
      const nutrient = nutrients[label];
      if (nutrient) macros[label] = { value: nutrient.value, unit: nutrient.unit };
    }

    return {
      foodId,
      name,
      servingSize,
      energy: nutrients.Energy ? { value: nutrients.Energy.value, unit: nutrients.Energy.unit } : undefined,
      macros,
      nutrients,
      rawText: bodyText.slice(0, 8000),
    };
  }).catch(() => undefined);
}

async function extractCustomRecipeDetail(page: Page): Promise<CustomRecipeDetail | undefined> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
    const numberFromText = (value: string | null | undefined) => {
      const match = normalize(value).match(/-?[0-9]+(?:\.[0-9]+)?/);
      return match ? Number(match[0]) : undefined;
    };
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const bodyText = normalize(document.body.innerText);
    const recipeId = bodyText.match(/Recipe\s+#(\d+)/i)?.[1];
    const nameInput = Array.from(document.querySelectorAll("input.text-box"))
      .find((element): element is HTMLInputElement => element instanceof HTMLInputElement && isVisible(element) && Boolean(normalize(element.value)));
    const titleName = bodyText.match(/BACK TO RECIPE LIST\s+(.+?)\s+(?:ADD TO DIARY|more_horiz|Recipe #|Info)/i)?.[1];
    const name = normalize(nameInput?.value || titleName || "");
    if (!name) return undefined;

    const editorInputs = Array.from(document.querySelectorAll("input.text-box, input.number-box"))
      .filter((element): element is HTMLInputElement => element instanceof HTMLInputElement && isVisible(element))
      .filter((element) => !String(element.className ?? "").includes("search-field"))
      .filter((element) => !element.closest(".popupContent,.gwt-DialogBox,[role='dialog']"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      .map((candidate) => candidate.element);
    const servingName = normalize(editorInputs[1]?.value) || undefined;
    const servings = numberFromText(editorInputs[2]?.value);

    const ingredients: Array<{
      name: string;
      database?: string;
      amount?: number;
      unit?: string;
      energyKcal?: number;
      weight?: string;
    }> = [];
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr")).filter(isVisible);
      const header = rows.find((row) => /Description/i.test(normalize(row.textContent)) && /\b(Database|Source)\b/i.test(normalize(row.textContent)) && /Amount/i.test(normalize(row.textContent)));
      if (!header) continue;
      for (const row of rows) {
        if (row === header || row.classList.contains("table-header")) continue;
        const cells = Array.from(row.querySelectorAll("td")).map((cell) => normalize(cell.textContent));
        if (cells.length < 4) continue;
        const ingredientName = cells[0];
        if (!ingredientName || /^Description$/i.test(ingredientName)) continue;
        ingredients.push({
          name: ingredientName,
          database: cells[1] || undefined,
          amount: numberFromText(cells[2]),
          unit: cells[3] || undefined,
          energyKcal: numberFromText(cells[4]),
          weight: cells[5] || undefined,
        });
      }
      if (ingredients.length) break;
    }

    return {
      recipeId,
      name,
      servingName,
      servings,
      ingredients,
      rawText: bodyText.slice(0, 8000),
    };
  }).catch(() => undefined);
}

function recipeServingsVerified(detail: CustomRecipeDetail | undefined, input: RecipeInput) {
  if (input.servings === undefined) return true;
  if (detail?.servings === undefined) return false;
  return Math.abs(detail.servings - input.servings) <= 0.000001;
}

function recipeIngredientsVerified(
  detail: CustomRecipeDetail | undefined,
  addedIngredients: Array<{ status?: string; selectedCandidate?: SearchResult; [key: string]: unknown }>,
) {
  const expected = addedIngredients
    .filter((item) => item.status === "ok")
    .map((item) => item.selectedCandidate?.name)
    .filter((name): name is string => Boolean(name));
  if (expected.length === 0) return true;
  const actual = detail?.ingredients?.map((ingredient) => normalizeFoodName(ingredient.name)) ?? [];
  if (actual.length < expected.length) return false;
  return expected.every((name) => {
    const normalized = normalizeFoodName(name);
    return actual.some((candidate) => candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate));
  });
}

async function retireOpenCustomFood(page: Page, target: CustomFoodDetail, retiredName: string) {
  const nameFilled = await fillCustomFoodName(page, retiredName);
  const saved = await clickByText(page, /^SAVE CHANGES$/i);
  if (saved) {
    await page.waitForTimeout(1200);
    await clickOptionalSaveConfirmation(page).catch(() => false);
    await page.waitForTimeout(900);
  }
  const finalDetail = await extractCustomFoodDetail(page).catch(() => undefined);
  return {
    target,
    retiredName,
    nameFilled,
    saved: Boolean(saved && nameFilled),
    finalDetail,
    visibleText: compactText(await page.locator("body").innerText().catch(() => ""), 8000),
  };
}

async function retireOpenCustomRecipe(page: Page, target: CustomRecipeDetail, retiredName: string) {
  const basics = await fillRecipeBasics(page, { name: retiredName, ingredients: [] });
  const saveClicked = await clickByText(page, /^SAVE CHANGES$/i) || await clickByText(page, /^SAVE$/i);
  await page.waitForTimeout(1000);
  const finalDetail = await extractCustomRecipeDetail(page).catch(() => undefined);
  const saved = basics.nameFilled && (finalDetail?.name === retiredName || Boolean(saveClicked));
  return {
    target,
    retiredName,
    basics,
    saveClicked,
    saved,
    finalDetail,
    visibleText: compactText(await page.locator("body").innerText().catch(() => ""), 8000),
  };
}

function retiredItemName(name: string, id?: string) {
  const today = new Date().toISOString().slice(0, 10);
  const suffix = id ? ` #${id}` : "";
  const base = name.replace(/^Retired\s+-\s+/i, "").trim();
  return `Retired - ${base}${suffix} - ${today}`;
}

async function chooseMeal(page: Page, meal?: string) {
  if (!meal) return;
  const normalizedMeal = meal.trim();
  const dialog = activeDialog(page);
  const mealDropdown = dialog
    .locator("button.dropdown-toggle:visible")
    .filter({ hasText: /^(Breakfast|Lunch|Dinner|Snacks|Snack|Supplements)$/i })
    .first();
  if ((await mealDropdown.count().catch(() => 0)) === 0) {
    await dialog.getByText(normalizedMeal, { exact: true }).click().catch(() => undefined);
    return;
  }
  const current = (await mealDropdown.innerText().catch(() => "")).trim();
  if (current.toLowerCase() === normalizedMeal.toLowerCase()) return;
  await mealDropdown.click();
  await page
    .locator(".dropdown-item:visible")
    .filter({ hasText: new RegExp(`^${escapeRegExp(normalizedMeal)}$`, "i") })
    .last()
    .click()
    .catch(() => undefined);
}

async function fillLikelyName(page: Page, name: string) {
  const selectors = [
    page.getByLabel(/name|description/i),
    page.locator('input[type="text"]:visible').first(),
  ];
  for (const selector of selectors) {
    if ((await selector.count().catch(() => 0)) === 0) continue;
    if (!(await selector.first().isVisible().catch(() => false))) continue;
    await selector.first().fill(name);
    return;
  }
}

async function fillRecipeBasics(page: Page, input: RecipeInput) {
  const result = {
    nameFilled: false,
    servingNameFilled: false,
    servingsFilled: false,
    cookedWeightFilled: false,
    cookedWeightUnitFilled: false,
  };
  result.nameFilled = await fillRecipeEditorInput(page, 0, input.name);
  if (!result.nameFilled) {
    await fillLikelyName(page, input.name);
    result.nameFilled = true;
  }

  if (input.servingName) {
    result.servingNameFilled = await fillRecipeEditorInput(page, 1, input.servingName);
  }

  if (input.servings) {
    result.servingsFilled = await fillRecipeEditorInput(page, 2, String(input.servings));
  }

  if (input.cookedWeight !== undefined) {
    result.cookedWeightFilled = await fillRecipeCookedWeight(page, input.cookedWeight, input.cookedWeightUnit);
    result.cookedWeightUnitFilled = Boolean(input.cookedWeightUnit && result.cookedWeightFilled);
  }
  return result;
}

async function fillRecipeEditorInput(page: Page, index: number, value: string) {
  const filled = await page.evaluate(({ index, value }) => {
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width >= 40 && rect.height >= 18 && style.display !== "none" && style.visibility !== "hidden";
    };
    const inputs = Array.from(document.querySelectorAll("input.text-box, input.number-box"))
      .filter((element): element is HTMLInputElement => element instanceof HTMLInputElement)
      .filter((element) => isVisible(element))
      .filter((element) => !String(element.className ?? "").includes("search-field"))
      .filter((element) => !element.closest(".popupContent,.gwt-DialogBox,[role='dialog']"))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      .map((candidate) => candidate.element);
    const input = inputs[index];
    if (!input) return false;
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    input.blur();
    return input.value === value;
  }, { index, value }).catch(() => false);
  await page.waitForTimeout(250);
  return filled;
}

async function fillRecipeCookedWeight(page: Page, cookedWeight: number, unit?: string) {
  const labels = [/cooked.*weight/i, /final.*weight/i, /total.*weight/i, /recipe.*weight/i];
  for (const label of labels) {
    const labelled = page.getByLabel(label).first();
    if (await labelled.isVisible().catch(() => false)) {
      await labelled.fill(String(cookedWeight)).catch(() => undefined);
      await page.keyboard.press("Tab").catch(() => undefined);
      if (unit) await fillLikelyUnit(page, unit);
      return true;
    }
  }

  const clicked = await clickByText(page, /^(Cooked Weight|Final Weight|Total Weight|Recipe Weight)$/i);
  if (!clicked) return false;
  await page.waitForTimeout(400);
  const input = await firstVisibleLocator(page, [
    page.locator("input.number-box:focus").first(),
    page.locator("input.text-box:focus").first(),
    page.locator("input.number-box:visible").last(),
    page.locator("input.text-box:visible").last(),
  ]);
  if (!input) return false;
  const filled = await input.fill(String(cookedWeight)).then(() => true).catch(() => false);
  await page.keyboard.press("Enter").catch(() => undefined);
  if (unit) await fillLikelyUnit(page, unit);
  return filled;
}

function chooseRecipeIngredientCandidate(ingredient: RecipeInput["ingredients"][number], candidates: SearchResult[]) {
  if (candidates.length === 0) return undefined;

  const selectedName = ingredient.selectedName?.trim();
  const selectedSource = ingredient.selectedSource?.trim();
  if (selectedName) {
    return candidates.find((candidate) =>
      normalizeFoodName(candidate.name) === normalizeFoodName(selectedName) &&
      (!selectedSource || normalizeSource(candidate.source) === normalizeSource(selectedSource))
    );
  }

  const exactQueryMatches = candidates.filter((candidate) => normalizeFoodName(candidate.name) === normalizeFoodName(ingredient.query));
  if (exactQueryMatches.length === 1) return exactQueryMatches[0];
  const officialExactMatches = exactQueryMatches.filter((candidate) => sourcePriority(candidate.source) >= 40);
  if (officialExactMatches.length > 0) return rankFoodResults(ingredient.query, officialExactMatches)[0];

  const confident = confidentRecipeIngredientCandidate(ingredient.query, candidates);
  if (confident) return confident;

  return undefined;
}

function confidentRecipeIngredientCandidate(query: string, candidates: SearchResult[]) {
  const ranked = rankFoodResults(query, candidates);
  const top = ranked[0];
  if (!top) return undefined;

  const normalizedQuery = normalizeFoodName(query);
  const normalizedTop = normalizeFoodName(top.name);
  const queryTokens = meaningfulFoodTokens(normalizedQuery);
  const topTokens = meaningfulFoodTokens(normalizedTop);
  const tokenCoverage = queryTokens.length > 0
    ? queryTokens.filter((token) => topTokens.includes(token)).length / queryTokens.length
    : 0;
  const nameCoverage = topTokens.length > 0
    ? topTokens.filter((token) => queryTokens.includes(token)).length / topTokens.length
    : 0;
  const topScore = foodResultScore(top, normalizedQuery);
  const nextScore = ranked[1] ? foodResultScore(ranked[1], normalizedQuery) : -Infinity;
  const official = sourcePriority(top.source) >= 40;

  if (official && tokenCoverage >= 0.95) return top;
  if (official && tokenCoverage >= 0.75 && nameCoverage >= 0.5 && topScore - nextScore >= 15) return top;
  if (official && topScore - nextScore >= 35 && tokenCoverage >= 0.5) return top;
  if (tokenCoverage >= 0.95 && nameCoverage >= 0.5 && topScore - nextScore >= 20) return top;
  if (tokenCoverage >= 0.95 && normalizedTop.startsWith(normalizedQuery) && topScore - nextScore >= 10) return top;
  return undefined;
}

function meaningfulFoodTokens(value: string) {
  return value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .filter((token) => !/^(the|a|an|and|or|of|with|plain|fresh|raw|dry|dried|cooked|natural|organic)$/.test(token));
}

async function addRecipeIngredient(page: Page, ingredient: RecipeInput["ingredients"][number], options: { deadline?: number; trace?: RecipeTrace } = {}) {
  options.trace?.("ingredient_add_button_click_start");
  const clickedAdd = await clickByText(page, /^ADD INGREDIENTS$/i);
  options.trace?.("ingredient_add_button_click_done", { clickedAdd });
  if (!clickedAdd) return { status: "add_button_not_found", warning: "ADD INGREDIENTS button was not found." };

  options.trace?.("ingredient_search_input_wait_start");
  const search = await waitForFoodSearchInput(page, 2500);
  options.trace?.("ingredient_search_input_wait_done", { found: Boolean(search) });
  if (!search) {
    return { status: "search_input_not_found", warning: "Ingredient search input was not found." };
  }

  const searchText = ingredient.selectedName ?? ingredient.query;
  await search.fill(searchText);
  options.trace?.("ingredient_search_submit_start");
  const searched = await clickDialogButton(page, /^SEARCH$/i);
  if (!searched) await clickByText(page, /^SEARCH$/i);
  options.trace?.("ingredient_search_submit_done", { searched });
  options.trace?.("ingredient_search_result_wait_start");
  await waitForIngredientSearchResult(page, searchText, Math.min(8000, Math.max(1200, (options.deadline ?? Date.now() + 8000) - Date.now() - 2500)));
  options.trace?.("ingredient_search_result_wait_done");

  options.trace?.("ingredient_collect_results_start");
  const candidates = rankFoodResults(
    ingredient.query,
    await collectFoodSearchResults(page, 12),
    ingredient.selectedName,
    ingredient.selectedSource,
  );
  options.trace?.("ingredient_collect_results_done", { candidateCount: candidates.length });
  const selectedCandidate = chooseRecipeIngredientCandidate(ingredient, candidates);
  options.trace?.("ingredient_candidate_selected", {
    selected: Boolean(selectedCandidate),
    selectedName: selectedCandidate?.name,
    selectedSource: selectedCandidate?.source,
    topCandidates: selectedCandidate ? undefined : candidates.slice(0, 5),
  });
  if (!selectedCandidate) {
    return {
      status: candidates.length > 0 ? "ambiguous_result" : "no_results",
      warning: candidates.length > 0
        ? "No exact selectedName/selectedSource match was found. Call resolve_recipe_ingredients and pass the chosen selectedName and selectedSource."
        : "No ingredient candidates found.",
      candidates,
    };
  }

  options.trace?.("ingredient_row_wait_start", { selectedName: selectedCandidate.name });
  const selectedSource = ingredient.selectedSource ?? selectedCandidate.source;
  await waitForRecipeSearchResultRow(page, selectedCandidate.name, selectedSource, Math.min(6000, Math.max(700, (options.deadline ?? Date.now() + 6000) - Date.now() - 2500)));
  options.trace?.("ingredient_row_wait_done");
  options.trace?.("ingredient_row_select_start");
  const selected = await selectRecipeIngredientSearchResult(page, selectedCandidate.name, selectedSource);
  options.trace?.("ingredient_row_select_done", { selected });
  if (!selected) {
    const selectionDebug = await recipeIngredientSelectionDebug(page, selectedCandidate.name);
    return { status: "result_not_selected", warning: "Could not select the exact searched ingredient row.", selectedCandidate, candidates, selectionDebug };
  }

  options.trace?.("ingredient_editor_wait_start");
  const editorReady = await waitForRecipeIngredientEditor(page, 3500, selectedCandidate.name);
  options.trace?.("ingredient_editor_wait_done", { editorReady });
  if (!editorReady) {
    return { status: "editor_not_opened", warning: "Selected ingredient result did not open the ingredient amount editor.", selectedCandidate };
  }

  options.trace?.("ingredient_unit_fill_start");
  let convertedAmount = await convertGramAmountForCurrentServingUnit(page, ingredient.amount, ingredient.unit, selectedCandidate.name);
  if (convertedAmount) options.trace?.("ingredient_unit_preconvert_done", {
    converted: convertedAmount.converted,
    currentUnitText: convertedAmount.currentUnitText,
    gramsPerServing: convertedAmount.gramsPerServing,
  });
  const unit = convertedAmount?.converted === true
    ? {
      filled: true,
      skipped: false,
      unit: ingredient.unit?.trim() ?? "",
      strategy: "converted-current-serving",
      currentUnitText: convertedAmount.currentUnitText,
      warning: undefined,
    }
    : await fillLikelyUnit(page, ingredient.unit);
  options.trace?.("ingredient_unit_fill_done", { filled: unit?.filled, skipped: unit?.skipped, strategy: unit?.strategy });
  convertedAmount = unit?.filled === false
    ? await convertGramAmountForCurrentServingUnit(page, ingredient.amount, ingredient.unit, selectedCandidate.name)
    : convertedAmount;
  if (convertedAmount) options.trace?.("ingredient_unit_convert_done", { converted: convertedAmount.converted });
  if (unit?.filled === false && convertedAmount?.converted !== true) {
    return { status: "unit_not_found", warning: unit.warning ?? convertedAmount?.warning ?? "Ingredient unit could not be selected or converted safely.", selectedCandidate, unit, convertedAmount };
  }
  options.trace?.("ingredient_amount_fill_start");
  const amount = convertedAmount?.converted === true
    ? convertedAmount.amount
    : await fillLikelyAmount(page, ingredient.amount, selectedCandidate.name);
  options.trace?.("ingredient_amount_fill_done", { filled: amount?.filled, skipped: amount?.skipped });
  if (amount?.filled === false) {
    return { status: "amount_not_filled", warning: amount.warning ?? "Ingredient amount input was not found.", selectedCandidate, amount, unit, convertedAmount };
  }

  options.trace?.("ingredient_confirm_add_start");
  const added = await clickDialogButton(page, /^(ADD|ADD INGREDIENT|ADD TO RECIPE|ADD SERVING|SAVE|DONE|OK)$/i);
  const addVerified = added ? await waitForRecipeIngredientAdded(page, selectedCandidate.name, 3500) : false;
  options.trace?.("ingredient_confirm_add_done", { added, addVerified });
  if (!added) return {
    status: "add_button_not_found",
    warning: "Could not find the ingredient add/save button after selecting amount.",
    selectedCandidate,
    amount,
    unit,
    convertedAmount,
    editorDebug: await recipeIngredientEditorDebug(page),
  };

  return { status: "ok", selectedCandidate, amount, unit, convertedAmount, addVerified };
}

async function recipeIngredientEditorDebug(page: Page) {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const dialog = Array.from(document.querySelectorAll(".pretty-dialog, [role='dialog'], .gwt-DialogBox, .popupContent"))
      .filter(isVisible)
      .at(-1) ?? document.body;
    const controls = Array.from(dialog.querySelectorAll("input, button, select, .gwt-Button, [role='button']"))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const input = element instanceof HTMLInputElement ? element : undefined;
        return {
          tag: element.tagName,
          className: String((element as HTMLElement).className ?? ""),
          role: element.getAttribute("role") ?? "",
          text: normalize(element.textContent),
          type: input?.type,
          value: input?.value,
          placeholder: input?.placeholder,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
    const selectedPanels = Array.from(dialog.querySelectorAll(".food-search-name, .d-flex, .my-3"))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          className: String((element as HTMLElement).className ?? ""),
          text: normalize(element.textContent).slice(0, 240),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
    return { controls, selectedPanels };
  }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
}

async function recipeIngredientSelectionDebug(page: Page, selectedName: string) {
  return page.evaluate((selectedName) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const target = normalize(selectedName).toLowerCase();
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const containers = Array.from(document.querySelectorAll(".pretty-dialog, [role='dialog'], .gwt-DialogBox, .popupContent"))
      .filter(isVisible)
      .map((element) => ({
        tag: element.tagName,
        className: String((element as HTMLElement).className ?? ""),
        textStart: normalize(element.textContent).slice(0, 240),
        hasTarget: normalize(element.textContent).toLowerCase().includes(target),
        hasDescriptionSource: /description\s+source/i.test(element.textContent ?? ""),
      }));
    const matchingElements = Array.from(document.querySelectorAll("body *"))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = normalize(element.textContent);
        return {
          tag: element.tagName,
          className: String((element as HTMLElement).className ?? ""),
          role: element.getAttribute("role") ?? "",
          text,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((element) => element.text.toLowerCase().includes(target))
      .sort((a, b) => a.text.length - b.text.length)
      .slice(0, 20);
    return { target: selectedName, containers, matchingElements };
  }, selectedName).catch((error) => ({ target: selectedName, error: error instanceof Error ? error.message : String(error) }));
}

async function selectRecipeIngredientSearchResult(page: Page, selectedName: string, selectedSource?: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clicked = await clickRecipeFoodResultRow(page, selectedName, selectedSource, attempt === 1);
    if (!clicked) return false;
    if (await waitForRecipeIngredientEditor(page, 1600, selectedName)) return true;
  }
  return false;
}

async function clickRecipeFoodResultRow(page: Page, selectedName: string, selectedSource: string | undefined, doubleClick: boolean) {
  const box = await page.evaluate(({ selectedName, selectedSource }) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const target = normalize(selectedName);
    const sourceTarget = normalize(selectedSource);
    const isVisible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const containers = Array.from(document.querySelectorAll(".pretty-dialog, [role='dialog'], .gwt-DialogBox, .popupContent"))
      .filter(isVisible);
    const dialog = containers
      .slice()
      .reverse()
      .find((element) => normalize(element.textContent).includes(target) && /description\s+source/i.test(element.textContent ?? ""))
      ?? containers.slice().reverse().find((element) => normalize(element.textContent).includes(target))
      ?? document.body;

    const rows = Array.from(dialog.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td,th"));
      const firstCellText = normalize(cells[0]?.textContent);
      const rowText = normalize(row.textContent);
      if (firstCellText !== target && !rowText.startsWith(`${target} `)) continue;
      if (sourceTarget && !rowText.includes(sourceTarget)) continue;
      const targetElement = (cells[0] as HTMLElement | undefined) ?? (row as HTMLElement);
      targetElement.scrollIntoView({ block: "center" });
      const rect = targetElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return undefined;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    if (!sourceTarget) {
      const exactTextElements = Array.from(dialog.querySelectorAll("*"))
        .filter(isVisible)
        .filter((element) => normalize(element.textContent) === target)
        .map((element) => ({ element, rect: element.getBoundingClientRect(), depth: elementDepth(element) }))
        .filter((candidate) => candidate.rect.width > 0 && candidate.rect.height > 0)
        .sort((a, b) => b.depth - a.depth || a.rect.y - b.rect.y);
      if (exactTextElements[0]) {
        const rect = exactTextElements[0].rect;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }

      const prefixElements = Array.from(dialog.querySelectorAll("*"))
        .filter(isVisible)
        .map((element) => {
          const text = normalize(element.textContent);
          const rect = element.getBoundingClientRect();
          return { element, text, rect, depth: elementDepth(element), area: rect.width * rect.height };
        })
        .filter((candidate) => candidate.rect.width > 0 && candidate.rect.height > 0)
        .filter((candidate) => candidate.text.startsWith(target) && candidate.text.length <= target.length + 30)
        .sort((a, b) => a.area - b.area || b.depth - a.depth || a.rect.y - b.rect.y);
      if (prefixElements[0]) {
        const rect = prefixElements[0].rect;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    return undefined;

    function elementDepth(element: Element) {
      let depth = 0;
      let current: Element | null = element;
      while (current) {
        depth += 1;
        current = current.parentElement;
      }
      return depth;
    }
  }, { selectedName, selectedSource }).catch(() => undefined);
  if (!box) return false;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (doubleClick) {
    await page.mouse.dblclick(x, y);
  } else {
    await page.mouse.click(x, y);
  }
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(250);
  return true;
}

async function waitForRecipeIngredientEditor(page: Page, timeoutMs: number, selectedName?: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await recipeIngredientSelectedPanel(page, selectedName)) return true;
    const dialogText = await activeDialog(page).innerText({ timeout: 500 }).catch(() => "");
    const hasSearchResults = /\bDescription\s+Source\b/i.test(dialogText);
    const hasAddButton = /\b(ADD TO RECIPE|ADD SERVING|DONE|SAVE|OK)\b/i.test(dialogText);
    if (!hasSearchResults && hasAddButton) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function waitForRecipeIngredientAdded(page: Page, selectedName: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const target = normalizeFoodName(selectedName);
  while (Date.now() < deadline) {
    const dialogText = await activeDialog(page).innerText({ timeout: 500 }).catch(() => "");
    const bodyText = await page.locator("body").innerText({ timeout: 800 }).catch(() => "");
    const dialogStillSearching = /\bDescription\s+Source\b/i.test(dialogText);
    const visibleInRecipe = normalizeFoodName(bodyText).includes(target);
    if (!dialogStillSearching && visibleInRecipe) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function recipeIngredientSelectedPanel(page: Page, selectedName?: string) {
  return page.evaluate((selectedName) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const target = normalize(selectedName).toLowerCase();
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const dialogs = Array.from(document.querySelectorAll(".pretty-dialog, [role='dialog'], .gwt-DialogBox, .popupContent"))
      .filter(isVisible);
    const root = dialogs.at(-1) ?? document.body;
    const panels = Array.from(root.querySelectorAll(".food-search-name, .selected-food, .food-search-serving-size, .d-flex.justify-content-center.my-3"))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = normalize(element.textContent);
        return {
          text,
          className: String((element as HTMLElement).className ?? ""),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((panel) => panel.text && (!target || panel.text.toLowerCase().includes(target)));
    return panels[0];
  }, selectedName).catch(() => undefined);
}

async function waitForRecipeSearchResultRow(page: Page, selectedName: string, selectedSource: string | undefined, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(({ selectedName, selectedSource }) => {
      const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const target = normalize(selectedName);
      const sourceTarget = normalize(selectedSource);
      const isVisible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      return Array.from(document.querySelectorAll("tr,td,.gwt-HTML,.food-search-name"))
        .filter(isVisible)
        .some((element) => {
          const text = normalize(element.textContent);
          return text.includes(target) && (!sourceTarget || text.includes(sourceTarget));
        });
    }, { selectedName, selectedSource }).catch(() => false);
    if (found) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function convertGramAmountForCurrentServingUnit(page: Page, amount?: number, unit?: string, selectedName?: string) {
  if (amount === undefined || unit?.trim().toLowerCase() !== "g") return undefined;
  const unitText = await currentRecipeUnitText(page);
  const gramsPerServing = gramsPerServingUnit(unitText);
  if (!gramsPerServing) return { converted: false, unitText, warning: "Current serving unit does not expose a gram weight for conversion." };
  const convertedAmount = Number((amount / gramsPerServing).toFixed(6));
  const filled = await fillLikelyAmount(page, convertedAmount, selectedName);
  return {
    converted: filled?.filled === true,
    originalAmount: amount,
    originalUnit: unit,
    convertedAmount,
    currentUnitText: unitText,
    gramsPerServing,
    amount: filled,
  };
}

function gramsPerServingUnit(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const exact = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)$/i);
  if (exact?.[1]) return Number(exact[1]);
  const annotated = normalized.match(/[—-]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)\b/i)
    ?? normalized.match(/\(\s*([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)\s*\)/i)
    ?? normalized.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:g|gram|grams)\b/i);
  if (annotated?.[1]) return Number(annotated[1]);
  return undefined;
}

async function waitForFoodSearchInput(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = await firstVisibleLocator(page, [
      activeDialog(page).getByPlaceholder(/Search all foods/i),
      activeDialog(page).getByPlaceholder(/Search/i),
      activeDialog(page).locator("input.gwt-TextBox.search-field:visible").last(),
      activeDialog(page).locator('input[type="text"]:visible').last(),
    ]);
    if (input) return input;
    await page.waitForTimeout(150);
  }
  return undefined;
}

async function waitForIngredientSearchResult(page: Page, name: string, timeoutMs: number) {
  const expected = name.toLowerCase();
  return waitForVisibleText(
    page,
    (text) => text.toLowerCase().includes(expected) || /\b(no results|no foods found|did not match)\b/i.test(text),
    Math.max(500, timeoutMs),
  );
}

function parseDailySummary(rawText: string) {
  const extract = (name: string, unit: string) => {
    const regex = new RegExp(`${escapeRegExp(name)}\\s+([+\\-]?[0-9,.]+)(?:\\s*\\([^)]*\\))?\\s*/\\s*([+\\-]?[0-9,.]+)\\s*${escapeRegExp(unit)}`, "i");
    const match = rawText.match(regex);
    if (!match) return undefined;
    return {
      current: Number(match[1]?.replace(/,/g, "")),
      target: Number(match[2]?.replace(/,/g, "")),
      unit,
    };
  };

  return {
    energy: extract("Energy", "kcal"),
    protein: extract("Protein", "g"),
    netCarbs: extract("Net Carbs", "g"),
    fat: extract("Fat", "g"),
  };
}

function parseFoodSearchResults(rawText: string, limit: number): SearchResult[] {
  const markerIndex = foodSearchResultMarkerIndex(rawText);
  const searchText = markerIndex >= 0 ? rawText.slice(markerIndex) : rawText;
  const stopMarkers = ["Energy Summary", "Nutrient Targets", "DAILY TARGET EDITOR"];
  const stop = stopMarkers
    .map((markerText) => searchText.indexOf(markerText))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  const relevantText = stop ? searchText.slice(0, stop) : searchText;

  return relevantText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 2)
    .filter((line) => !/^(SEARCH|All|Favorites|Common Foods|Beverages|Supplements|Brands|Restaurants|Custom|Recipes)$/i.test(line))
    .map((line) => {
      const sourceMatch = line.match(foodSourcePattern());
      return {
        name: sourceMatch ? line.slice(0, sourceMatch.index).trim() : line,
        source: sourceMatch?.[1],
        raw: line,
      };
    })
    .filter((item, index, items) => items.findIndex((candidate) =>
      normalizeFoodName(candidate.name) === normalizeFoodName(item.name) &&
      normalizeSource(candidate.source) === normalizeSource(item.source)
    ) === index)
    .slice(0, limit);
}

function foodSearchResultMarkerIndex(rawText: string) {
  const direct = rawText.match(/\bDescription\s+Source\b/i);
  if (direct?.index !== undefined) return direct.index + direct[0].length;

  const lineMatches = Array.from(rawText.matchAll(/^Description\s*$/gim));
  for (const match of lineMatches) {
    const after = rawText.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 120);
    const source = after.match(/^\s*Source\s*$/im);
    if (source?.index !== undefined) return (match.index ?? 0) + match[0].length + source.index + source[0].length;
  }
  return -1;
}

async function extractFoodSearchResults(page: Page, limit: number): Promise<SearchResult[]> {
  const dialog = activeDialog(page);
  return dialog
    .locator("tr")
    .evaluateAll((rows, max) => {
      const results = [];
      for (const row of rows) {
        if (row.classList.contains("table-header")) continue;
        const cells = Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean);
        const name = row.querySelector(".gwt-HTML")?.textContent?.replace(/\s+/g, " ").trim() || cells[0];
        const source = row.querySelector(".source")?.textContent?.replace(/\s+/g, " ").trim() || cells[1];
        if (!name || /^Description$/i.test(name)) continue;
        results.push({
          name,
          source: source || undefined,
          raw: `${name}${source ? ` ${source}` : ""}`,
        });
        if (results.length >= Number(max)) break;
      }
      return results;
    }, limit)
    .catch(() => []);
}

async function collectFoodSearchResults(page: Page, limit: number) {
  const tableResults = await extractFoodSearchResults(page, limit * 2);
  const dialogText = await activeDialog(page).innerText().catch(() => "");
  const textResults = parseFoodSearchResults(dialogText, limit * 2);
  return mergeFoodResults([...tableResults, ...textResults]).slice(0, limit);
}

function parseFoodRowText(rawText: string): SearchResult | undefined {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const compact = rawText.replace(/\s+/g, " ").trim();
  if (!compact || /^(Description Source|SEARCH)$/i.test(compact)) return undefined;

  if (lines.length >= 2 && !/Description/i.test(lines[0])) {
    return { name: lines[0], source: lines[1], raw: compact };
  }

  const sourceMatch = compact.match(foodSourcePattern());
  const name = sourceMatch ? compact.slice(0, sourceMatch.index).trim() : compact;
  if (!name || /^(Description|Source)$/i.test(name)) return undefined;
  return { name, source: sourceMatch?.[1], raw: compact };
}

function mergeFoodResults(results: SearchResult[]) {
  const merged: SearchResult[] = [];
  for (const result of results) {
    const name = result.name.replace(/\s+/g, " ").trim();
    if (!name || /^(Description|Source)$/i.test(name)) continue;
    if (merged.some((candidate) =>
      normalizeFoodName(candidate.name) === normalizeFoodName(name) &&
      normalizeSource(candidate.source) === normalizeSource(result.source)
    )) continue;
    merged.push({ ...result, name });
  }
  return merged;
}

export function foodSearchTabAttempts(scope: FoodLogInput["searchScope"], selectedSource?: string) {
  const source = normalizeSource(selectedSource);
  const attempts: Array<string | undefined> = [];
  const add = (tab: string | undefined) => {
    if (!attempts.some((candidate) => candidate === tab)) attempts.push(tab);
  };

  if (scope === "all") add("All");
  else if (scope === "custom") add("Custom");
  else if (scope === "favorites") add("Favorites");
  else if (source.includes("custom")) {
    add("Custom");
    add("All");
  } else if (source) {
    add("All");
    add(undefined);
  } else {
    add("All");
    add("Custom");
    add("Favorites");
    add(undefined);
  }

  return attempts.length ? attempts : [undefined, "Custom", "Favorites", "All"];
}

export function chooseFoodLogResult(input: FoodLogInput, results: SearchResult[]) {
  const policy = input.matchPolicy ?? "high_confidence";
  const ranked = rankFoodResults(input.query, results, input.selectedName, input.selectedSource);
  const candidates = ranked.slice(0, 5);
  const selectedName = input.selectedName?.trim();
  const selectedSource = normalizeSource(input.selectedSource);

  if (selectedName) {
    const normalizedSelected = normalizeFoodName(selectedName);
    const matches = ranked.filter((result) =>
      normalizeFoodName(result.name) === normalizedSelected &&
      (!selectedSource || normalizeSource(result.source) === selectedSource)
    );
    if (matches.length === 1 || (matches.length > 1 && selectedSource)) {
      return {
        status: "ok" as const,
        policy,
        result: matches[0],
        candidates,
        confidence: foodLogConfidence(input.query, matches[0], ranked.find((candidate) => candidate !== matches[0])),
      };
    }
    return {
      status: "needs_manual_step" as const,
      policy,
      candidates,
      warning: selectedSource
        ? `The selected food ${selectedName} from ${input.selectedSource} was not found in the visible Cronometer results.`
        : `Multiple or no visible Cronometer rows matched selectedName=${selectedName}. Pass selectedSource from search_foods to avoid logging the wrong row.`,
      nextStep: "Call search_foods for the query, then call log_food with the chosen selectedName and selectedSource.",
    };
  }

  if (policy === "selected_only") {
    return {
      status: "needs_manual_step" as const,
      policy,
      candidates,
      warning: "matchPolicy=selected_only requires selectedName from a prior search_foods result.",
      nextStep: "Call search_foods first, then pass selectedName and selectedSource to log_food.",
    };
  }

  const top = ranked[0];
  if (!top) {
    return {
      status: "needs_manual_step" as const,
      policy,
      candidates,
      warning: "No Cronometer food result was found.",
      nextStep: "Try a more specific food query or create a custom food first.",
    };
  }

  const next = ranked[1];
  const confidence = foodLogConfidence(input.query, top, next);
  if (policy === "best_effort" || confidence.highConfidence) {
    return {
      status: "ok" as const,
      policy,
      result: top,
      candidates,
      confidence,
    };
  }

  return {
    status: "needs_manual_step" as const,
    policy,
    candidates,
    confidence,
    warning: "Cronometer returned multiple plausible food matches, so cronogpt refused to log one automatically.",
    nextStep: "Call log_food with selectedName and selectedSource from the preferred candidate, or set matchPolicy=best_effort if the top result is acceptable.",
  };
}

export function foodLogConfidence(query: string, top: SearchResult, next?: SearchResult) {
  const normalizedQuery = normalizeFoodName(query);
  const normalizedName = normalizeFoodName(top.name);
  const topScore = foodResultScore(top, normalizedQuery);
  const nextScore = next ? foodResultScore(next, normalizedQuery) : undefined;
  const scoreGap = nextScore === undefined ? Number.POSITIVE_INFINITY : topScore - nextScore;
  const exactName = normalizedName === normalizedQuery;
  const plainName = normalizedName === `${normalizedQuery} plain`;
  const highConfidence = exactName || plainName || !next || (topScore >= 85 && scoreGap >= 30) || (topScore >= 70 && scoreGap >= 45);
  return {
    highConfidence,
    exactName,
    plainName,
    topScore,
    nextScore,
    scoreGap: Number.isFinite(scoreGap) ? scoreGap : undefined,
  };
}

export function rankFoodResults(query: string, results: SearchResult[], selectedName?: string, selectedSource?: string) {
  const normalizedQuery = normalizeFoodName(query);
  const normalizedSelected = selectedName ? normalizeFoodName(selectedName) : undefined;
  const normalizedSelectedSource = normalizeSource(selectedSource);
  return [...results]
    .sort((a, b) => {
      const aScore = foodResultScore(a, normalizedQuery, normalizedSelected, normalizedSelectedSource);
      const bScore = foodResultScore(b, normalizedQuery, normalizedSelected, normalizedSelectedSource);
      return bScore - aScore;
    });
}

export function foodResultScore(result: SearchResult, normalizedQuery: string, normalizedSelected?: string, normalizedSelectedSource?: string) {
  const normalizedName = normalizeFoodName(result.name);
  let score = sourcePriority(result.source);
  if (normalizedSelected) {
    if (normalizedName === normalizedSelected) score += 200;
    else if (normalizedName.startsWith(normalizedSelected) || normalizedSelected.startsWith(normalizedName)) score += 80;
    else if (normalizedName.includes(normalizedSelected) || normalizedSelected.includes(normalizedName)) score += 40;
  }
  if (normalizedSelectedSource && normalizeSource(result.source) === normalizedSelectedSource) score += 70;
  if (normalizedName === normalizedQuery) score += 100;
  else if (normalizedName === `${normalizedQuery} plain`) score += 65;
  else if (normalizedName.startsWith(normalizedQuery)) score += 45;
  else if (normalizedName.includes(normalizedQuery)) score += 25;
  if (/\bplain\b/i.test(result.name)) score += 5;
  return score;
}

function sourcePriority(source?: string) {
  const normalized = normalizeSource(source);
  if (!normalized) return 0;
  if (normalized === "crdb") return 60;
  if (normalized === "nccdb") return 55;
  if (normalized === "usda") return 50;
  if (normalized === "cnf") return 45;
  if (normalized.includes("custom")) return 35;
  if (normalized.includes("common")) return 25;
  if (normalized.includes("brand") || normalized.includes("restaurant")) return 10;
  return 5;
}

export function normalizeSource(source?: string) {
  return (source ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hasExactFoodResult(query: string, results: SearchResult[]) {
  const normalizedQuery = normalizeFoodName(query);
  return results.some((result) => normalizeFoodName(result.name) === normalizedQuery);
}

function foodSourcePattern() {
  return /\b(Custom Recipe|Custom Food|Custom Meal|Recipe|NCCDB|USDA|CNF|CRDB|Restaurant|Brand|Common Food|Survey|Label)$/i;
}

function pickFoodResult(query: string, results: SearchResult[], selectedName?: string) {
  if (selectedName) {
    const selected = results.find((result) => result.name.toLowerCase() === selectedName.toLowerCase());
    if (selected) return selected;
  }

  const ranked = rankFoodResults(query, results, selectedName);
  const normalizedQuery = normalizeFoodName(query);
  return (
    ranked.find((result) => normalizeFoodName(result.name) === normalizedQuery) ??
    ranked.find((result) => normalizeFoodName(result.name) === `${normalizedQuery} plain`) ??
    ranked.find((result) => /\bplain\b/i.test(result.name)) ??
    ranked[0]
  );
}

export function normalizeFoodName(value: string) {
  return value
    .toLowerCase()
    .replace(/[,()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTime(value: string) {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const explicitPeriod = match[3]?.toUpperCase();
  if (hour > 23 || minute > 59) return undefined;
  const period = explicitPeriod ?? (hour >= 12 ? "PM" : "AM");
  if (hour === 0) hour = 12;
  if (hour > 12) hour -= 12;
  return { hour12: hour, minute, period };
}

function loginFailureReason(text: string) {
  if (/Too Many Attempts/i.test(text)) {
    return "Cronometer is rate-limiting login attempts: Too Many Attempts. Please try again later.";
  }
  if (/captcha|robot|verify|challenge|cloudflare/i.test(text)) {
    return "Cronometer is showing a bot/CAPTCHA verification challenge.";
  }
  if (/One-Time Code|two.factor|2fa|verification code/i.test(text)) {
    return "Cronometer is asking for a one-time code or two-factor verification.";
  }
  if (/invalid|incorrect/i.test(text)) {
    return "Cronometer rejected the configured email or password.";
  }
  return undefined;
}

function isLoginCooldownError(message: string) {
  return /login is paused|Too Many Attempts|rate-limiting login attempts/i.test(message);
}

function isProbeTimeoutError(message: string) {
  return /Timed out (running|opening)|Timeout .* exceeded|page\.goto: Timeout/i.test(message);
}

function isLoggedInText(text: string) {
  if (/\bWelcome Back\b|\bLog In\b|\bSign Up\b|Too Many Attempts|captcha|robot|verify|Science-backed nutrition tracking|Sign Up For Free/i.test(text)) return false;
  return (/\bDashboard\b/i.test(text) && /\b(Diary|Trends|Foods)\b/i.test(text))
    || /\bCustom Recipes\b/i.test(text) && /\b(CREATE RECIPE|IMPORT RECIPE|Sorted by|BACK TO RECIPE LIST)\b/i.test(text)
    || /\bCustom Foods\b/i.test(text) && /\b(CREATE FOOD|Sorted by|BACK TO FOODS LIST)\b/i.test(text)
    || /\bEnergy Summary\b/i.test(text) && /\b(Nutrient Targets|Diary)\b/i.test(text);
}

function normalizeEmail(email?: string) {
  return email?.trim().toLowerCase();
}

function textHasEmail(text: string, expectedEmail: string) {
  return text.toLowerCase().includes(expectedEmail);
}

function extractEmails(text: string) {
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  return Array.from(new Set(matches.map((email) => email.toLowerCase())));
}

function redactEmail(email?: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return undefined;
  const [local, domain = ""] = normalized.split("@");
  const localPrefix = local.slice(0, Math.min(2, local.length));
  const domainParts = domain.split(".");
  const domainName = domainParts[0] ?? "";
  const domainSuffix = domainParts.length > 1 ? `.${domainParts.at(-1)}` : "";
  return `${localPrefix}${local.length > 2 ? "***" : "*"}@${domainName.slice(0, 2)}***${domainSuffix}`;
}

function compactText(text: string, maxLength: number) {
  const normalized = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

async function firstVisibleLocator(page: Page, locators: ReturnType<Page["locator"]>[]) {
  for (const locator of locators) {
    if ((await locator.count().catch(() => 0)) === 0) continue;
    const candidate = locator.first();
    if (!(await candidate.isVisible().catch(() => false))) continue;
    return candidate;
  }
  return undefined;
}

async function waitForFirstVisibleLocator(page: Page, locators: ReturnType<Page["locator"]>[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await firstVisibleLocator(page, locators);
    if (candidate) return candidate;
    await page.waitForTimeout(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  return undefined;
}

function safeInput<T>(input: T): T {
  if (!input || typeof input !== "object") return input;
  const copy = { ...(input as Record<string, unknown>) };
  delete copy.password;
  delete copy.email;
  return copy as T;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
