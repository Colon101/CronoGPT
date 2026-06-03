import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type {
  BiometricLogInput,
  Capability,
  CustomFoodDeleteInput,
  CustomFoodDuplicateInput,
  CustomFoodInput,
  CustomFoodListInput,
  CustomFoodRetireInput,
  CustomFoodSelectorInput,
  CustomFoodUpdateInput,
  CustomRecipeSelectorInput,
  DateRangeInput,
  ExerciseLogInput,
  ExportDataInput,
  FastInput,
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
  operationTimeoutMs: number;
  browserRetryCount: number;
  timeZone: string;
  reuseRemoteContext?: boolean;
  reuseLocalBrowser?: boolean;
}

interface SearchResult {
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
  browser: Browser;
  context: BrowserContext;
  page: Page;
  closeContext?: boolean;
  closeBrowser?: boolean;
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
    const loginPaused = now < loginBackoffUntil;
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
      writeEnabled: this.config.writeEnabled,
      requireFoodConfirmation: this.config.requireFoodConfirmation,
      activeBrowserJobs,
      queuedBrowserJobs,
      operationTimeoutMs: this.config.operationTimeoutMs,
      browserRetryCount: this.config.browserRetryCount,
      reuseLocalBrowser: this.config.reuseLocalBrowser,
      loginPaused,
      loginPauseSecondsRemaining: loginPaused ? Math.ceil((loginBackoffUntil - now) / 1000) : 0,
      lastLoginFailure,
      guidance: [
        "Use dryRun=true for validation and previews; dry-run write tools do not open Cronometer.",
        "Call refresh_cronometer_session before a long browser workflow to warm and verify the current hosted session.",
        "Use resolve_recipe_ingredients with a low limitPerIngredient and a larger maxSeconds value for large recipes.",
        "If loginPaused is true, wait or provide durable storage state/remote browser before retrying browser actions.",
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
      const outcome = await this.searchFoodUi(page, input.query, input.limit ?? 10);
      const results = rankFoodResults(input.query, outcome.results);
      return this.result("search_foods", "ok", {
        query: input.query,
        results,
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
    return this.withPage("log_food", async (page) => {
      const { results: preview, dateStatus } = await this.searchFoodUi(page, input.query, 5, input.date);
      if (input.date && !dateStatus.selected) {
        return this.result(
          "log_food",
          "needs_manual_step",
          { input: safeInput(input), dateStatus },
          dateStatus.warning ?? "Could not apply the requested diary date. No write was attempted.",
        );
      }
      const shouldWrite =
        this.config.writeEnabled &&
        input.dryRun !== true &&
        input.confirmed !== false &&
        (!this.config.requireFoodConfirmation || input.confirmed === true);

      if (!shouldWrite) {
        const reason = !this.config.writeEnabled
          ? "Cronometer writes are disabled on the server."
          : input.dryRun === true
            ? "Dry-run preview requested."
            : input.confirmed === false
              ? "The request explicitly declined confirmation."
              : "Food log confirmation is required by CRONOMETER_REQUIRE_FOOD_CONFIRMATION.";
        return this.result("log_food", "dry_run", {
          input: safeInput(input),
          dateStatus,
          preview,
          reason,
          nextStep: this.config.writeEnabled
            ? "Call again without dryRun=true to write the explicit food log."
            : "Set CRONOMETER_ENABLE_WRITES=true to allow Cronometer diary writes.",
        });
      }

      if (preview.length === 0) {
        return this.result("log_food", "needs_manual_step", { input: safeInput(input) }, "No matching Cronometer food result was found.");
      }

      const selectedResult = pickFoodResult(input.query, preview, input.selectedName);
      const selectedName = selectedResult?.name ?? input.selectedName ?? input.query;
      const clicked = await clickFoodSearchResult(page, selectedName);
      if (!clicked) {
        return this.result(
          "log_food",
          "needs_manual_step",
          { input: safeInput(input), selectedName, preview },
          "Found food candidates but could not select one with stable UI selectors.",
        );
      }

      await page.waitForTimeout(1000);
      await fillFoodAmount(page, input.amount);
      await fillFoodTime(page, input.timestamp);
      await fillFoodUnit(page, input.unit);
      await chooseMeal(page, input.meal);

      const saved = await clickDialogButton(page, /^(ADD|ADD TO DIARY|ADD TO DIARY|SAVE|DONE)$/i);
      if (!saved) {
        return this.result(
          "log_food",
          "needs_manual_step",
          { input: safeInput(input), selectedName },
          "Selected the food but could not find a stable add/save button. Nothing was intentionally saved.",
        );
      }

      await page.waitForTimeout(1500);
      return this.result("log_food", "ok", {
        logged: { ...safeInput(input), selectedName },
        dateStatus,
        visibleText: compactText(await this.visibleText(page), 6000),
      });
    });
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
    const duplicatePolicy = input.duplicatePolicy ?? "update_existing";
    if (!confirmedWrite) {
      return this.result("create_custom_food", "dry_run", {
        input: safeInput(input),
        duplicatePolicy,
        reason: writeGateReason(input, this.config.writeEnabled),
        nextStep: this.config.writeEnabled
          ? "Call again with confirmed=true. duplicatePolicy defaults to update_existing for exactly one same-named food, fails on multiple matches, and creates only when no match exists."
          : "Set CRONOMETER_ENABLE_WRITES=true to allow Cronometer custom food writes.",
      });
    }

      return this.withPage("create_custom_food", async (page) => {
      await this.openApp(page, "#custom-foods");
      const existing = await resolveCustomFoodTargets(page, { name: input.name }, { maxDetails: 12, timeoutMs: this.config.navigationTimeoutMs });
      if (existing.targets.length > 0 && duplicatePolicy === "fail") {
        return this.result("create_custom_food", "needs_manual_step", {
          input: safeInput(input),
          duplicatePolicy,
          existingFoods: existing.targets,
          duplicateGroups: duplicateGroups(existing.targets.map((food) => food.name)),
          nextStep: "Use update_custom_food with foodId/name to edit an existing food, or call create_custom_food with duplicatePolicy=create_new if a duplicate is intentional.",
        }, "A custom food with this name already exists. Refusing to create a duplicate by default.");
      }

      const shouldUpdateExisting = existing.targets.length === 1 && duplicatePolicy === "update_existing";
      if (existing.targets.length > 1 && duplicatePolicy === "update_existing") {
        return this.result("create_custom_food", "needs_manual_step", {
          input: safeInput(input),
          duplicatePolicy,
          existingFoods: existing.targets,
          nextStep: "More than one matching custom food exists. Call update_custom_food with a specific foodId.",
        }, "Cannot update existing because multiple matching custom foods were found.");
      }

      const openedExisting = shouldUpdateExisting ? await openCustomFoodTarget(page, existing.targets[0]) : false;
      const openedCreateForm = openedExisting || await clickByText(page, /^CREATE FOOD$/i);
      if (!openedCreateForm) {
        const visibleText = compactText(await this.visibleText(page), 10000);
        return this.result("create_custom_food", "needs_manual_step", { input: safeInput(input), visibleText }, "Could not find an existing custom food or CREATE FOOD.");
      }

      await page.waitForTimeout(1200);
      const nameFilled = await fillCustomFoodName(page, input.name);
      const serving = await fillCustomFoodServing(page, input.servingSize);
      const nutrients = await fillCustomFoodNutrients(page, input.nutrients ?? {});

      const saved = await clickByText(page, /^SAVE CHANGES$/i);
      if (!saved) {
        return this.result(
          "create_custom_food",
          "needs_manual_step",
          {
            input: safeInput(input),
            nameFilled,
            serving,
            nutrients,
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
          visibleText: compactText(listText, 12000),
        },
        listed ? undefined : "Clicked Save Changes, but the custom food was not found in the Custom Foods list afterward.",
      );
    });
  }

  async updateCustomFood(input: CustomFoodUpdateInput & { confirmed?: boolean }) {
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
        afterSaveText,
      });
    });
  }

  async deleteCustomFood(input: CustomFoodDeleteInput & { confirmed?: boolean }) {
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
      const deleteClicked = await clickByText(page, /^(DELETE|DELETE FOOD|REMOVE)$/i);
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
      const trace: RecipeTrace = (step, details) => logRecipeStep(input.name, startedAt, step, details);
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
            visibleText: compactText(await this.visibleText(page).catch(() => ""), 10000),
          }, "Stopped before the hosted operation budget expired. Retry with the remaining ingredients or use fewer ingredients per call.");
        }
        trace("ingredient_start", { ingredientIndex: index });
        const added = await addRecipeIngredient(page, ingredient, {
          deadline,
          trace: (step, details) => trace(step, { ingredientIndex: index, ...details }),
        });
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

  private async searchFoodUi(page: Page, query: string, limit: number, date?: string): Promise<FoodSearchOutcome> {
    const dateStatus = await this.openFoodSearchDialog(page, date);
    if (date && !dateStatus.selected) return { results: [], dateStatus };

    const attempts: Array<string | undefined> = [undefined, "Custom", "Favorites", "All"];
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
    const alreadyOpen = await activeDialog(page).isVisible().catch(() => false);
    if (!alreadyOpen) {
      await clickByText(page, /^FOOD$/i);
      await page.waitForTimeout(1000);
    }
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
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(1200);
    if (await this.isLoggedIn(page)) {
      await this.ensureConfiguredAccount(page, hash);
      if (hash && !page.url().includes(hash)) {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
        await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
        await page.waitForTimeout(900);
      }
      return;
    }

    await this.login(page);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(1200);
    if (!(await this.isLoggedIn(page))) {
      throw new Error("Cronometer login succeeded but the app page did not load.");
    }
    await this.ensureConfiguredAccount(page, hash);
    if (hash && !page.url().includes(hash)) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
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

    const firstCheck = await this.verifyConfiguredAccount(page, expectedEmail, returnHash, "current-session");
    if (firstCheck.verified) return;

    if (!this.config.password) {
      throw new Error(`Cronometer session is logged in, but the configured account ${redactEmail(this.config.email)} could not be verified.`);
    }

    await this.login(page);
    const secondCheck = await this.verifyConfiguredAccount(page, expectedEmail, returnHash, "fresh-login");
    if (secondCheck.verified) return;

    const detected = secondCheck.detectedEmails.length
      ? secondCheck.detectedEmails.map((email) => redactEmail(email)).join(", ")
      : "no visible email";
    throw new Error(`Cronometer login did not verify the configured account ${redactEmail(this.config.email)}. Account page showed ${detected}.`);
  }

  private async verifyConfiguredAccount(page: Page, expectedEmail: string, returnHash: string, source: string) {
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
    return { verified: false, detectedEmails };
  }

  private async readAccountPageText(page: Page, returnHash: string) {
    await page.goto(`${CRONOMETER_ORIGIN}/#account`, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(1200);
    const text = await this.visibleText(page).catch(() => "");
    if (returnHash && returnHash !== "#account") {
      await page.goto(`${CRONOMETER_ORIGIN}/${returnHash}`, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout(600).catch(() => undefined);
    }
    return text;
  }

  private async login(page: Page) {
    if (Date.now() < loginBackoffUntil) {
      const waitSeconds = Math.ceil((loginBackoffUntil - Date.now()) / 1000);
      throw new Error(`Cronometer login is paused for ${waitSeconds}s to avoid more rate-limit attempts. Last failure: ${lastLoginFailure ?? "unknown"}`);
    }

    await page.context().clearCookies().catch(() => undefined);
    await page.goto(`${CRONOMETER_ORIGIN}/login/`, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    }).catch(() => undefined);
    await page.goto(`${CRONOMETER_ORIGIN}/login/`, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
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

    const emailInput = await waitForFirstVisibleLocator(page, [
      page.getByLabel(/email/i),
      page.locator("#username"),
      page.locator('input[name="username"]'),
      page.locator('input[type="email"]'),
      page.getByPlaceholder(/email/i),
    ], this.config.navigationTimeoutMs);
    const passwordInput = await waitForFirstVisibleLocator(page, [
      page.getByLabel(/^password$/i),
      page.locator("#password"),
      page.locator('input[name="password"]'),
      page.locator('input[type="password"]'),
      page.getByPlaceholder(/password/i),
    ], this.config.navigationTimeoutMs);
    if (!emailInput || !passwordInput) {
      const loginText = compactText(await this.visibleText(page).catch(() => ""), 2000);
      throw new Error(`Cronometer login form did not render expected fields. Visible text: ${loginText}`);
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
    cachedStorageState = await page.context().storageState().catch(() => cachedStorageState);
  }

  private async isLoggedIn(page: Page, text?: string) {
    const bodyText = text ?? (await this.visibleText(page).catch(() => ""));
    return isLoggedInText(bodyText);
  }

  private pauseLoginAttempts(reason: string) {
    lastLoginFailure = reason;
    loginBackoffUntil = Date.now() + this.config.loginBackoffMs;
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

    return enqueueBrowserJob(() => this.withPageAttemptWithRetry(feature, handler));
  }

  private async withPageAttemptWithRetry(feature: string, handler: (page: Page) => Promise<ProviderResult>): Promise<ProviderResult> {
    const attempts = Math.max(1, Math.min(this.config.browserRetryCount + 1, 3));
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
      if (Date.now() < loginBackoffUntil && !this.storageState()) {
        const waitSeconds = Math.ceil((loginBackoffUntil - Date.now()) / 1000);
        return this.result(
          feature,
          "error",
          undefined,
          `Cronometer login is paused for ${waitSeconds}s to avoid more rate-limit attempts. Last failure: ${lastLoginFailure ?? "unknown"}`,
          "browser",
        );
      }
      const operationTimeoutMs = this.featureOperationTimeoutMs(feature);
      session = await withTimeout(this.newSession(), operationTimeoutMs, `Timed out opening Cronometer browser session after ${operationTimeoutMs}ms.`);
      const result = await withTimeout(handler(session.page), operationTimeoutMs, `Timed out running ${feature} after ${operationTimeoutMs}ms.`);
      cachedStorageState = await session.context.storageState().catch(() => cachedStorageState);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser automation error";
      if (!this.config.remoteWsEndpoint && this.config.reuseLocalBrowser) {
        await this.closeCachedLocalSession();
      }
      return this.result(feature, "error", { attempt }, message, "browser");
    } finally {
      if (session?.closeContext !== false) await session?.context.close().catch(() => undefined);
      if (session?.closeBrowser !== false) await session?.browser.close().catch(() => undefined);
    }
  }

  private featureOperationTimeoutMs(feature: string) {
    const timeoutMs = this.config.operationTimeoutMs;
    if (/^(create_recipe|update_custom_recipe|resolve_recipe_ingredients)$/.test(feature)) {
      return Math.min(timeoutMs, 210000);
    }
    if (/^(list_custom_recipes|list_custom_foods|list_custom_meals)$/.test(feature)) {
      return Math.min(timeoutMs, 120000);
    }
    return timeoutMs;
  }

  private async newSession(): Promise<BrowserSession> {
    if (!this.config.remoteWsEndpoint && this.config.reuseLocalBrowser) {
      const cached = await this.usableCachedLocalSession();
      if (cached) return cached;
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
    if (!cachedLocalSession.browser.isConnected() || cachedLocalSession.page.isClosed()) {
      await this.closeCachedLocalSession();
      return undefined;
    }
    return cachedLocalSession;
  }

  private async closeCachedLocalSession() {
    const cached = cachedLocalSession;
    cachedLocalSession = undefined;
    await cached?.context.close().catch(() => undefined);
    await cached?.browser.close().catch(() => undefined);
  }

  private hasRunnableBrowser() {
    return Boolean(this.config.remoteWsEndpoint || this.config.localChromium);
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
      executablePath: this.config.chromiumExecutablePath,
      args: [
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
      ],
      headless: true,
      timeout: this.config.navigationTimeoutMs,
    });
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

async function enqueueBrowserJob<T>(task: () => Promise<T>): Promise<T> {
  queuedBrowserJobs += 1;
  const run = browserQueue
    .catch(() => undefined)
    .then(async () => {
      queuedBrowserJobs -= 1;
      activeBrowserJobs += 1;
      try {
        return await task();
      } finally {
        activeBrowserJobs -= 1;
      }
    });
  browserQueue = run.then(() => undefined, () => undefined);
  return run;
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
      return true;
    }
  }
  return false;
}

async function searchCurrentFoodDialog(page: Page, query: string, limit: number) {
  const searchBox = await foodSearchBox(page);
  if (!searchBox) {
    throw new Error("Food search input was not found after opening the Cronometer food dialog.");
  }

  await searchBox.click();
  await page.keyboard.press("Control+A").catch(() => undefined);
  await page.keyboard.type(query, { delay: 10 });
  await searchBox.fill(query).catch(() => undefined);
  const searched = await clickDialogButton(page, /^SEARCH$/i);
  if (!searched) {
    await clickByText(page, /^SEARCH$/i);
  }
  await page.waitForTimeout(1800);

  return collectFoodSearchResults(page, limit);
}

async function foodSearchBox(page: Page) {
  return firstVisibleLocator(page, [
    activeDialog(page).getByPlaceholder(/Search all foods/i),
    activeDialog(page).getByPlaceholder(/Search/i),
    activeDialog(page).locator("input.gwt-TextBox.search-field:visible").last(),
    activeDialog(page).locator('input[type="text"]:visible').last(),
  ]);
}

async function clickFoodSearchResult(page: Page, selectedName: string) {
  const dialog = activeDialog(page);
  const exactCell = dialog.locator(".gwt-HTML").filter({ hasText: new RegExp(`^${escapeRegExp(selectedName)}$`, "i") });
  if ((await exactCell.count().catch(() => 0)) > 0 && (await exactCell.first().isVisible().catch(() => false))) {
    await exactCell.first().click();
    return true;
  }

  const rows = dialog.locator("tr:visible");
  const count = await rows.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const parsed = parseFoodRowText(await row.innerText().catch(() => ""));
    if (!parsed) continue;
    if (normalizeFoodName(parsed.name) !== normalizeFoodName(selectedName)) continue;

    await row.scrollIntoViewIfNeeded().catch(() => undefined);
    await row.focus().catch(() => undefined);
    await row.click().catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
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
  if (!amount) return;
  const dialog = activeDialog(page);
  const textBoxes = dialog.locator("input.text-box:visible");
  const count = await textBoxes.count().catch(() => 0);
  if (count === 0) return;
  await textBoxes.nth(count - 1).fill(String(amount));
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
  if (!unit) return;
  const dialog = activeDialog(page);
  const unitButton = dialog
    .locator("button.dropdown-toggle:visible")
    .filter({ hasText: /g|oz|serving|size|cup|tbsp|tsp|piece|slice|pint|pt|quart|ml|liter|litre/i })
    .last();
  if ((await unitButton.count().catch(() => 0)) === 0) return;
  await unitButton.click();
  const option = page.locator(".dropdown-item:visible").filter({ hasText: new RegExp(escapeRegExp(unit), "i") }).first();
  if ((await option.count().catch(() => 0)) > 0) {
    await option.click().catch(() => undefined);
  } else {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
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
    const selected = await select.selectOption({ label: normalizedUnit }).then(() => true).catch(() => false);
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
  return labels.some((label) =>
    normalizedText === label ||
    normalizedText.startsWith(`${label} `) ||
    normalizedText.startsWith(`${label}—`) ||
    normalizedText.startsWith(`${label} —`) ||
    normalizedText.startsWith(`${label}-`) ||
    normalizedText.startsWith(`${label} -`)
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
    await roleOption.click().catch(() => undefined);
    return true;
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
    const matches = (text: string, unit: string) => {
      const normalizedText = normalize(text).toLowerCase();
      const labels = [unit, ...aliases(unit)];
      return labels.some((label) =>
        normalizedText === label ||
        normalizedText.startsWith(`${label} `) ||
        normalizedText.startsWith(`${label}—`) ||
        normalizedText.startsWith(`${label} —`) ||
        normalizedText.startsWith(`${label}-`) ||
        normalizedText.startsWith(`${label} -`)
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
        return { text, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
      .filter((candidate) => candidate.text && matches(candidate.text, normalizedUnit))
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));
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

  result.amountFilled = await fillServingSizeCell(page, 0, String(parsed.amount));
  result.measureFilled = await fillServingSizeCell(page, 1, parsed.unit);

  const rowText = await servingSizeRowText(page);
  if (!result.amountFilled || !result.measureFilled || !new RegExp(`\\b${escapeRegExp(String(parsed.amount))}\\b`, "i").test(rowText) || !/\bg\b/i.test(rowText)) {
    result.warning = "Could not verify Cronometer serving size row after editing.";
  }
  return result;
}

function parseServingSize(value?: string) {
  const match = value?.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(g|gram|grams)$/i);
  if (!match) return undefined;
  const grams = Number(match[1]);
  if (!Number.isFinite(grams) || grams <= 0) return undefined;
  return { amount: grams, unit: "g", grams };
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

function customFoodNutrientEntries(nutrients: Record<string, number>) {
  const mapped = new Map<string, { label: string; value: number; sourceKey: string }>();
  for (const [key, value] of Object.entries(nutrients)) {
    if (!Number.isFinite(value)) continue;
    const label = customFoodNutrientLabelForKey(key);
    if (!label) continue;
    mapped.set(label, { label, value, sourceKey: key });
  }
  return Array.from(mapped.values());
}

async function fillCustomFoodNutrient(page: Page, label: string, value: number) {
  await scrollNutrientRowIntoView(page, label);
  await page.waitForTimeout(250);
  const cellBox = await nutrientAmountCellBox(page, label);
  if (!cellBox) {
    const fallback = await fillNutritionLabelNutrient(page, label, value);
    if (fallback) return fallback;
    return { status: "not_found" as const, warning: `Could not find nutrient row: ${label}` };
  }

  const inputCountsBeforeClick = await visibleInputCounts(page, ["input.number-box:visible"]);
  const clickedCellBox = await clickNutrientAmountCell(page, label);
  if (!clickedCellBox) {
    await page.mouse.click(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
  }
  await page.waitForTimeout(450);

  const input = await focusedOrNearestInput(page, clickedCellBox ?? cellBox, ["input.number-box:visible"])
    ?? await newestVisibleInputIfAdded(page, ["input.number-box:visible"], inputCountsBeforeClick);
  if (!input) {
    const fallback = await fillNutritionLabelNutrient(page, label, value);
    if (fallback) return fallback;
    return { status: "not_found" as const, warning: `No editable amount input appeared for ${label}.` };
  }

  await input.fill(String(value));
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(550);

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
  const inputCountsBeforeClick = await visibleInputCounts(page, selectors);
  await page.mouse.click(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
  await page.waitForTimeout(450);
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
  await page.waitForTimeout(600);

  const labelText = await nutritionLabelText(page, nutritionLabel);
  const verified = rowTextIncludesValue(labelText, value);
  return {
    status: verified ? ("ok" as const) : ("unverified" as const),
    rowText: labelText,
    source: "nutrition_label" as const,
    warning: verified ? undefined : `Filled ${nutritionLabel}, but the updated nutrition label text could not be verified.`,
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

type RecipeTrace = (step: string, details?: Record<string, unknown>) => void;

function logRecipeStep(recipeName: string, startedAt: number, step: string, details: Record<string, unknown> = {}) {
  try {
    console.log(JSON.stringify({
      feature: "create_recipe",
      recipeName,
      step,
      elapsedMs: Date.now() - startedAt,
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

async function resolveCustomFoodTargets(page: Page, selector: CustomFoodSelectorInput, options: { maxDetails: number; timeoutMs?: number }) {
  const rawText = await waitForCustomItemListText(page, "Custom Foods", options.timeoutMs ?? 12000);
  const names = parseCustomItemListNames(rawText, "Custom Foods");
  const query = selector.name;
  const matchingNames = query ? exactOrFuzzyCustomItemNames(names, query) : names;
  const candidateNames = query && matchingNames.length === 0 ? [query] : matchingNames;
  const details = await customFoodDetailsForNames(page, candidateNames, options.maxDetails);
  const targets = details.filter((detail) => {
    if (selector.foodId && detail.foodId !== selector.foodId) return false;
    if (selector.name && detail.name.toLowerCase() !== selector.name.toLowerCase()) return false;
    return Boolean(selector.foodId || selector.name);
  });
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

async function openCustomFoodTarget(page: Page, target: CustomFoodDetail) {
  await page.goto(`${CRONOMETER_ORIGIN}/#custom-foods`);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await waitForCustomItemListText(page, "Custom Foods", 12000).catch(() => "");
  const clicked = await clickCustomListItemByName(page, target.name, target.occurrence ?? 0);
  if (!clicked) return false;
  await page.waitForTimeout(1000);
  if (!target.foodId) return true;
  const detail = await extractCustomFoodDetail(page);
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
  return page.evaluate(({ name, occurrence }) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
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
    const candidates = Array.from(document.querySelectorAll("body *"))
      .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
      .filter((element) => normalize(element.innerText || element.textContent) === name)
      .map((element) => ({ element, rect: element.getBoundingClientRect(), depth: depth(element) }))
      .filter((candidate) => candidate.rect.y > 120)
      .sort((a, b) => a.rect.y - b.rect.y || b.depth - a.depth || a.rect.x - b.rect.x);
    const target = candidates[occurrence]?.element ?? candidates[0]?.element;
    if (!target) return false;
    target.scrollIntoView({ block: "center" });
    const rect = target.getBoundingClientRect();
    for (const type of ["mousedown", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }));
    }
    return true;
  }, { name, occurrence }).catch(() => false);
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
  const unit = await fillLikelyUnit(page, ingredient.unit);
  options.trace?.("ingredient_unit_fill_done", { filled: unit?.filled, skipped: unit?.skipped, strategy: unit?.strategy });
  const convertedAmount = unit?.filled === false
    ? await convertGramAmountForCurrentServingUnit(page, ingredient.amount, ingredient.unit, selectedCandidate.name)
    : undefined;
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
  const exact = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*g$/i);
  if (exact?.[1]) return Number(exact[1]);
  const annotated = normalized.match(/[—-]\s*([0-9]+(?:\.[0-9]+)?)\s*g\b/i)
    ?? normalized.match(/\(\s*([0-9]+(?:\.[0-9]+)?)\s*g\s*\)/i)
    ?? normalized.match(/\b([0-9]+(?:\.[0-9]+)?)\s*g\b/i);
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

function rankFoodResults(query: string, results: SearchResult[], selectedName?: string, selectedSource?: string) {
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

function foodResultScore(result: SearchResult, normalizedQuery: string, normalizedSelected?: string, normalizedSelectedSource?: string) {
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

function normalizeSource(source?: string) {
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

function normalizeFoodName(value: string) {
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
