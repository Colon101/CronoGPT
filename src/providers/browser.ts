import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type {
  BiometricLogInput,
  Capability,
  CustomFoodInput,
  DateRangeInput,
  ExerciseLogInput,
  ExportDataInput,
  FastInput,
  FoodLogInput,
  NoteLogInput,
  ProviderResult,
  RecipeInput,
  ResolveRecipeIngredientsInput,
  RepeatItemInput,
  SearchFoodsInput,
  TargetsInput,
} from "../domain.js";
import { BaseCronometerProvider } from "./base.js";
import { capabilitiesForMode } from "../features.js";

export interface BrowserConfig {
  email?: string;
  password?: string;
  remoteWsEndpoint?: string;
  storageState?: string;
  serverlessChromium: boolean;
  writeEnabled: boolean;
  requireFoodConfirmation: boolean;
  navigationTimeoutMs: number;
  loginBackoffMs: number;
}

interface SearchResult {
  name: string;
  source?: string;
  raw: string;
}

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const CRONOMETER_ORIGIN = "https://cronometer.com";
let cachedStorageState: unknown;
let loginBackoffUntil = 0;
let lastLoginFailure: string | undefined;

export class BrowserCronometerProvider extends BaseCronometerProvider {
  constructor(private readonly config: BrowserConfig) {
    super("browser", "browser");
  }

  async capabilities(): Promise<ProviderResult<Capability[]>> {
    const browserConfigured = Boolean(this.hasRunnableBrowser() && this.config.email && this.config.password);
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
      browserConfigured ? undefined : "Set Cronometer credentials and either enable serverless Chromium or provide REMOTE_CHROME_WS_ENDPOINT.",
    );
  }

  async readFeaturePage(feature: string, hash: string, input: unknown) {
    return this.readPage(feature, hash, input);
  }

  async getDailySummary(input: DateRangeInput) {
    return this.withPage("get_daily_summary", async (page) => {
      await this.openApp(page, "#diary");
      const rawText = await this.visibleText(page);
      return this.result("get_daily_summary", "ok", {
        date: input.date ?? new Date().toISOString().slice(0, 10),
        summary: parseDailySummary(rawText),
        rawText: compactText(rawText, 18000),
      });
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
      const results = await this.searchFoodUi(page, input.query, input.limit ?? 10);
      return this.result("search_foods", "ok", {
        query: input.query,
        results,
      });
    });
  }

  async resolveRecipeIngredients(input: ResolveRecipeIngredientsInput) {
    const limit = Math.min(input.limitPerIngredient ?? 3, 5);
    const maxMs = Math.min(input.maxSeconds ?? 45, 50) * 1000;
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
            warning: "Skipped before the hosted function timeout. Call resolve_recipe_ingredients again with the remaining ingredients.",
            matches: { query: ingredient.query, results: [] },
          });
          continue;
        }

        let results = await searchCurrentFoodDialog(page, ingredient.query, limit);
        if (results.length === 0 && Date.now() < deadline - 6500) {
          const customClicked = await clickFoodDialogFilter(page, "Custom");
          if (customClicked) {
            results = await searchCurrentFoodDialog(page, ingredient.query, limit);
            await clickFoodDialogFilter(page, "All").catch(() => undefined);
          }
        }

        resolved.push({
          ingredient,
          status: results.length > 0 ? "ok" : "needs_manual_step",
          warning: results.length > 0 ? undefined : "No Cronometer matches were found for this ingredient.",
          matches: { query: ingredient.query, results },
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
      const preview = await this.searchFoodUi(page, input.query, 5);
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

  async createCustomFood(input: CustomFoodInput & { confirmed?: boolean }) {
    return this.createCustomItem("create_custom_food", "#custom-foods", "CREATE FOOD", input);
  }

  async createRecipe(input: RecipeInput & { confirmed?: boolean }) {
    const preview = {
      recipeName: input.name,
      servings: input.servings,
      servingName: input.servingName,
      ingredients: input.ingredients,
    };

    if (input.dryRun !== false || !input.confirmed || !this.config.writeEnabled) {
      return this.result("create_recipe", "dry_run", {
        input: safeInput(input),
        preview,
        nextStep: "Call again with dryRun=false and confirmed=true after reviewing exact Cronometer ingredient matches.",
      });
    }

    return this.withPage("create_recipe", async (page) => {
      await this.openApp(page, "#custom-recipes");
      const opened = await clickByText(page, /^CREATE RECIPE$/i);
      if (!opened) {
        return this.result("create_recipe", "needs_manual_step", { input: safeInput(input) }, "Could not find CREATE RECIPE.");
      }

      await page.waitForTimeout(1200);
      await fillRecipeBasics(page, input);

      const addedIngredients = [];
      for (const ingredient of input.ingredients) {
        const added = await addRecipeIngredient(page, ingredient);
        addedIngredients.push({ ingredient, ...added });
      }

      const visibleText = await this.visibleText(page);
      const allAdded = addedIngredients.every((item) => item.status === "ok");
      const nameVisible = visibleText.toLowerCase().includes(input.name.toLowerCase());

      return this.result(allAdded && nameVisible ? "create_recipe" : "create_recipe", allAdded && nameVisible ? "ok" : "needs_manual_step", {
        recipeName: input.name,
        addedIngredients,
        visibleText: compactText(visibleText, 12000),
      }, allAdded && nameVisible ? "Cronometer recipe editor was filled. Cronometer appears to autosave recipe edits in this UI." : "Recipe editor opened, but one or more ingredients could not be verified.");
    });
  }

  async getTargets(input: DateRangeInput) {
    return this.readPage("get_targets", "#profile", input);
  }

  async setTargets(input: TargetsInput & { confirmed?: boolean }) {
    return this.confirmedPageWrite("set_targets", "#profile", input, "Targets + Profile writes need verified field selectors.");
  }

  async exportData(input: ExportDataInput & { confirmed?: boolean }) {
    if (input.dryRun !== false || !input.confirmed || !this.config.writeEnabled) {
      return this.result("export_data", "dry_run", {
        input: safeInput(input),
        nextStep: "Call with dryRun=false and confirmed=true to click EXPORT DATA.",
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
      await this.openApp(page, "#diary");
      const rawText = await this.visibleText(page);
      return this.result(feature, "ok", {
        date: input.date ?? new Date().toISOString().slice(0, 10),
        hints,
        rawText: compactText(rawText, 14000),
      });
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
    if (input.dryRun !== false || !input.confirmed || !this.config.writeEnabled) {
      return this.result(feature, "dry_run", {
        input: safeInput(input),
        nextStep: `Call again with dryRun=false and confirmed=true to open ${createButtonText}.`,
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
    if (input.dryRun !== false || !input.confirmed || !this.config.writeEnabled) {
      return this.result(feature, "dry_run", {
        input: safeInput(input),
        nextStep: `Call again with dryRun=false and confirmed=true to open ${buttonText}.`,
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
    const confirmedWrite = input.dryRun === false && input.confirmed && this.config.writeEnabled;
    if (!confirmedWrite) {
      return this.result(feature, "dry_run", {
        input: safeInput(input),
        hash,
        nextStep: "Call again with dryRun=false and confirmed=true after reviewing the requested change.",
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

  private async searchFoodUi(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    await this.openFoodSearchDialog(page);

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
        return results;
      }
    }

    if (fallbackResults.length > 0) {
      if (fallbackTab) {
        await clickFoodDialogFilter(page, fallbackTab);
      } else {
        await clickFoodDialogFilter(page, "All");
      }
      const visibleResults = await searchCurrentFoodDialog(page, query, limit);
      return visibleResults.length > 0 ? visibleResults : fallbackResults;
    }

    return [];
  }

  private async openFoodSearchDialog(page: Page) {
    await this.openApp(page, "#diary");
    const alreadyOpen = await activeDialog(page).isVisible().catch(() => false);
    if (!alreadyOpen) {
      await clickByText(page, /^FOOD$/i);
      await page.waitForTimeout(1000);
    }
  }

  private async openApp(page: Page, hash = "") {
    await page.goto(`${CRONOMETER_ORIGIN}/${hash}`);
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(1200);
    if (await this.isLoggedIn(page)) return;

    await this.login(page);
    await page.goto(`${CRONOMETER_ORIGIN}/${hash}`);
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(1200);
    if (!(await this.isLoggedIn(page))) {
      throw new Error("Cronometer login succeeded but the app page did not load.");
    }
  }

  private async login(page: Page) {
    if (Date.now() < loginBackoffUntil) {
      const waitSeconds = Math.ceil((loginBackoffUntil - Date.now()) / 1000);
      throw new Error(`Cronometer login is paused for ${waitSeconds}s to avoid more rate-limit attempts. Last failure: ${lastLoginFailure ?? "unknown"}`);
    }

    await page.goto(`${CRONOMETER_ORIGIN}/login/`);
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

    await page.getByLabel(/email/i).fill(this.config.email);
    await page.getByLabel(/password/i).fill(this.config.password);
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForTimeout(3500);

    const afterLoginText = await this.visibleText(page);
    if (!(await this.isLoggedIn(page, afterLoginText))) {
      const failure = loginFailureReason(afterLoginText) ?? "Cronometer login did not reach the app. Check credentials, CAPTCHA, or two-factor prompts.";
      this.pauseLoginAttempts(failure);
      throw new Error(failure);
    }

    loginBackoffUntil = 0;
    lastLoginFailure = undefined;
    cachedStorageState = await page.context().storageState().catch(() => cachedStorageState);
  }

  private async isLoggedIn(page: Page, text?: string) {
    const bodyText = text ?? (await this.visibleText(page).catch(() => ""));
    if (/\bWelcome Back\b|\bLOG IN\b|Too Many Attempts|captcha|robot|verify/i.test(bodyText)) return false;
    return /\bDashboard\b|\bDiary\b|\bTrends\b|\bFoods\b/.test(bodyText);
  }

  private pauseLoginAttempts(reason: string) {
    lastLoginFailure = reason;
    loginBackoffUntil = Date.now() + this.config.loginBackoffMs;
  }

  private async visibleText(page: Page) {
    return page.locator("body").innerText({ timeout: this.config.navigationTimeoutMs });
  }

  private async withPage(feature: string, handler: (page: Page) => Promise<ProviderResult>): Promise<ProviderResult> {
    if (!this.hasRunnableBrowser()) {
      return this.result(
        feature,
        "not_configured",
        {
          hasCredentials: Boolean(this.config.email && this.config.password),
          hasRemoteBrowser: Boolean(this.config.remoteWsEndpoint),
          serverlessChromium: this.config.serverlessChromium,
        },
        "Enable CRONOMETER_SERVERLESS_CHROMIUM or set REMOTE_CHROME_WS_ENDPOINT to a Browserless-compatible Chrome WebSocket endpoint.",
        "browser",
      );
    }

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
      session = await this.newSession();
      const result = await handler(session.page);
      cachedStorageState = await session.context.storageState().catch(() => cachedStorageState);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser automation error";
      return this.result(feature, "error", undefined, message, "browser");
    } finally {
      await session?.context.close().catch(() => undefined);
      await session?.browser.close().catch(() => undefined);
    }
  }

  private async newSession(): Promise<BrowserSession> {
    const browser = this.config.remoteWsEndpoint
      ? await chromium.connectOverCDP(this.config.remoteWsEndpoint, {
          timeout: this.config.navigationTimeoutMs,
        })
      : await this.launchServerlessChromium();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      locale: "en-US",
      storageState: this.storageState(),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    return { browser, context, page };
  }

  private hasRunnableBrowser() {
    return Boolean(this.config.remoteWsEndpoint || this.config.serverlessChromium);
  }

  private storageState() {
    if (cachedStorageState) return cachedStorageState;
    if (!this.config.storageState) return undefined;
    const raw = this.config.storageState.trim();
    try {
      return JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64url").toString("utf8"));
    } catch {
      try {
        return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      } catch {
        return undefined;
      }
    }
  }

  private async launchServerlessChromium() {
    const serverlessChromium = (await import("@sparticuz/chromium")).default;
    serverlessChromium.setGraphicsMode = false;
    return chromium.launch({
      args: [
        ...serverlessChromium.args,
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-sandbox",
      ],
      executablePath: await serverlessChromium.executablePath(),
      headless: true,
      timeout: this.config.navigationTimeoutMs,
    });
  }
}

async function clickByText(page: Page, label: string | RegExp) {
  const candidates = [
    page.getByRole("button", { name: label }),
    page.getByRole("link", { name: label }),
    page.locator("button,a,[role='button']").filter({ hasText: label }),
  ];

  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) === 0) continue;
    const first = candidate.first();
    if (!(await first.isVisible().catch(() => false))) continue;
    await first.click();
    return true;
  }
  return false;
}

function activeDialog(page: Page) {
  return page.locator(".pretty-dialog, [role='dialog'], .gwt-DialogBox").last();
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
  return false;
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

async function fillLikelyAmount(page: Page, amount?: number) {
  if (!amount) return;
  const amountText = String(amount);
  const selectors = [
    page.getByLabel(/amount|serving|quantity/i),
    page.locator("input[type='number']:visible").first(),
  ];
  for (const selector of selectors) {
    if ((await selector.count().catch(() => 0)) === 0) continue;
    if (!(await selector.first().isVisible().catch(() => false))) continue;
    await selector.first().fill(amountText);
    return;
  }
}

async function fillLikelyUnit(page: Page, unit?: string) {
  if (!unit) return;
  const selects = page.locator("select");
  const count = await selects.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    if (!(await select.isVisible().catch(() => false))) continue;
    await select.selectOption({ label: unit }).catch(() => undefined);
  }
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
  const textBoxes = page.locator("input.text-box:visible");
  if ((await textBoxes.count().catch(() => 0)) > 0) {
    await textBoxes.nth(0).fill(input.name).catch(() => undefined);
  } else {
    await fillLikelyName(page, input.name);
  }

  if (input.servingName && (await textBoxes.count().catch(() => 0)) > 1) {
    await textBoxes.nth(1).fill(input.servingName).catch(() => undefined);
  }

  if (input.servings && (await textBoxes.count().catch(() => 0)) > 2) {
    await textBoxes.nth(2).fill(String(input.servings)).catch(() => undefined);
  }
}

async function addRecipeIngredient(page: Page, ingredient: RecipeInput["ingredients"][number]) {
  const clickedAdd = await clickByText(page, /^ADD INGREDIENTS$/i);
  if (!clickedAdd) return { status: "not_found", warning: "ADD INGREDIENTS button was not found." };

  await page.waitForTimeout(800);
  const search = await firstVisibleLocator(page, [
    page.getByPlaceholder(/Search all foods/i),
    page.getByPlaceholder(/Search/i),
    page.locator("input.gwt-TextBox.search-field:visible").last(),
    page.locator('input[type="text"]:visible').last(),
  ]);
  if (!search) {
    return { status: "not_found", warning: "Ingredient search input was not found." };
  }

  await search.fill(ingredient.selectedName ?? ingredient.query);
  await clickByText(page, /^SEARCH$/i);
  await page.waitForTimeout(1200);

  const selected = await clickByText(page, ingredient.selectedName ?? ingredient.query);
  if (!selected) {
    const results = parseFoodSearchResults(await page.locator("body").innerText(), 5);
    if (results[0]?.name) {
      const clickedFirst = await clickByText(page, results[0].name);
      if (!clickedFirst) return { status: "not_found", warning: "Could not select a searched ingredient.", candidates: results };
    } else {
      return { status: "not_found", warning: "No ingredient candidates found." };
    }
  }

  await page.waitForTimeout(800);
  await fillLikelyAmount(page, ingredient.amount);
  await fillLikelyUnit(page, ingredient.unit);

  await clickByText(page, /^(ADD|ADD TO RECIPE|SAVE|DONE)$/i).catch(() => false);
  await page.waitForTimeout(800);

  return { status: "ok" };
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
  const marker = "Description Source";
  const start = rawText.indexOf(marker);
  const searchText = start >= 0 ? rawText.slice(start + marker.length) : rawText;
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
    .filter((item, index, items) => items.findIndex((candidate) => candidate.name === item.name) === index)
    .slice(0, limit);
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
    if (merged.some((candidate) => normalizeFoodName(candidate.name) === normalizeFoodName(name))) continue;
    merged.push({ ...result, name });
  }
  return merged;
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

  const normalizedQuery = normalizeFoodName(query);
  return (
    results.find((result) => normalizeFoodName(result.name) === normalizedQuery) ??
    results.find((result) => normalizeFoodName(result.name) === `${normalizedQuery} plain`) ??
    results.find((result) => /\bplain\b/i.test(result.name)) ??
    results[0]
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
  if (/invalid|incorrect/i.test(text)) {
    return "Cronometer rejected the configured email or password.";
  }
  return undefined;
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
