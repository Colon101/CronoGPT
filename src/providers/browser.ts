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
  writeEnabled: boolean;
  navigationTimeoutMs: number;
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

export class BrowserCronometerProvider extends BaseCronometerProvider {
  constructor(private readonly config: BrowserConfig) {
    super("browser", "browser");
  }

  async capabilities(): Promise<ProviderResult<Capability[]>> {
    const browserConfigured = Boolean(this.config.remoteWsEndpoint && this.config.email && this.config.password);
    const capabilities = capabilitiesForMode("mock").map((capability) => {
      if (capability.preferredBackend === "manual") {
        return { ...capability, currentBackendStatus: "unsupported" as const };
      }
      if (capability.preferredBackend === "terra" || capability.preferredBackend === "csv") {
        return { ...capability, currentBackendStatus: "needs_manual_step" as const };
      }
      return {
        ...capability,
        currentBackendStatus: browserConfigured ? ("ok" as const) : ("not_configured" as const),
      };
    });

    return this.result("cronometer_capabilities", browserConfigured ? "ok" : "not_configured", capabilities, browserConfigured ? undefined : "Set REMOTE_CHROME_WS_ENDPOINT plus Cronometer credentials.");
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

  async logFood(input: FoodLogInput & { confirmed?: boolean }) {
    return this.withPage("log_food", async (page) => {
      const preview = await this.searchFoodUi(page, input.query, 5);
      if (input.dryRun !== false || !input.confirmed || !this.config.writeEnabled) {
        return this.result("log_food", "dry_run", {
          input: safeInput(input),
          preview,
          nextStep: "Call again with dryRun=false and confirmed=true after the user confirms the exact food, amount, unit, date, and meal.",
        });
      }

      if (preview.length === 0) {
        return this.result("log_food", "needs_manual_step", { input: safeInput(input) }, "No matching Cronometer food result was found.");
      }

      const selectedName = preview[0]?.name ?? input.query;
      const clicked = await clickByText(page, selectedName);
      if (!clicked) {
        return this.result(
          "log_food",
          "needs_manual_step",
          { input: safeInput(input), selectedName, preview },
          "Found food candidates but could not select one with stable UI selectors.",
        );
      }

      await page.waitForTimeout(1000);
      await fillLikelyAmount(page, input.amount);
      await fillLikelyUnit(page, input.unit);
      await chooseMeal(page, input.meal);

      const saved = await clickByText(page, /^(ADD|ADD TO DIARY|SAVE|DONE)$/i);
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
    return this.withPage("create_recipe", async (page) => {
      await this.openApp(page, "#custom-recipes");
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
          visibleText: compactText(await this.visibleText(page), 10000),
          nextStep: "Call again with dryRun=false and confirmed=true after reviewing exact Cronometer ingredient matches.",
        });
      }

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
    return this.withPage("export_data", async (page) => {
      await this.openApp(page, "#account");
      if (input.dryRun !== false || !input.confirmed || !this.config.writeEnabled) {
        return this.result("export_data", "dry_run", {
          input: safeInput(input),
          visibleText: compactText(await this.visibleText(page), 10000),
          nextStep: "Call with dryRun=false and confirmed=true to click EXPORT DATA.",
        });
      }
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
    return this.withPage(feature, async (page) => {
      await this.openApp(page, hash);
      const visibleText = compactText(await this.visibleText(page), 10000);
      if (input.dryRun !== false || !input.confirmed || !this.config.writeEnabled) {
        return this.result(feature, "dry_run", {
          input: safeInput(input),
          visibleText,
          nextStep: `Call again with dryRun=false and confirmed=true to open ${createButtonText}.`,
        });
      }

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
    return this.withPage(feature, async (page) => {
      await this.openApp(page, "#diary");
      if (input.dryRun !== false || !input.confirmed || !this.config.writeEnabled) {
        return this.result(feature, "dry_run", {
          input: safeInput(input),
          nextStep: `Call again with dryRun=false and confirmed=true to open ${buttonText}.`,
        });
      }

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
    return this.withPage(feature, async (page) => {
      await this.openApp(page, hash);
      const confirmedWrite = input.dryRun === false && input.confirmed && this.config.writeEnabled;
      return this.result(feature, confirmedWrite ? "needs_manual_step" : "dry_run", {
        input: safeInput(input),
        hash,
        visibleText: compactText(await this.visibleText(page), 10000),
      }, warning);
    });
  }

  private async searchFoodUi(page: Page, query: string, limit: number): Promise<SearchResult[]> {
    await this.openApp(page, "#diary");
    await clickByText(page, /^FOOD$/i);
    await page.waitForTimeout(1000);

    const searchBox = page
      .locator('input[placeholder*="Search"], input.gwt-TextBox.search-field, input[type="text"]')
      .filter({ hasNotText: /^$/ })
      .first();
    await searchBox.fill(query);
    await clickByText(page, /^SEARCH$/i);
    await page.waitForTimeout(1800);

    const text = await this.visibleText(page);
    return parseFoodSearchResults(text, limit);
  }

  private async openApp(page: Page, hash = "") {
    await this.login(page);
    await page.goto(`${CRONOMETER_ORIGIN}/${hash}`);
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(1800);
  }

  private async login(page: Page) {
    await page.goto(`${CRONOMETER_ORIGIN}/login/`);
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(700);

    const bodyText = await this.visibleText(page);
    if (/\bDashboard\b|\bDiary\b/.test(bodyText) && !/\bWelcome Back\b/.test(bodyText)) return;

    if (!this.config.email || !this.config.password) {
      throw new Error("Missing CRONOMETER_EMAIL/CRONOMETER_PASSWORD.");
    }

    await page.getByLabel(/email/i).fill(this.config.email);
    await page.getByLabel(/password/i).fill(this.config.password);
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForTimeout(4500);

    const afterLoginText = await this.visibleText(page);
    if (!/\bDashboard\b|\bDiary\b/.test(afterLoginText)) {
      throw new Error("Cronometer login did not reach the app. Check credentials, CAPTCHA, or two-factor prompts.");
    }
  }

  private async visibleText(page: Page) {
    return page.locator("body").innerText({ timeout: this.config.navigationTimeoutMs });
  }

  private async withPage(feature: string, handler: (page: Page) => Promise<ProviderResult>): Promise<ProviderResult> {
    if (!this.config.remoteWsEndpoint) {
      return this.result(
        feature,
        "not_configured",
        { hasCredentials: Boolean(this.config.email && this.config.password), hasRemoteBrowser: false },
        "Set REMOTE_CHROME_WS_ENDPOINT to a Browserless or compatible Chrome WebSocket endpoint for hosted browser control.",
        "browser",
      );
    }

    let session: BrowserSession | undefined;
    try {
      session = await this.newSession();
      return await handler(session.page);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser automation error";
      return this.result(feature, "error", undefined, message, "browser");
    } finally {
      await session?.context.close().catch(() => undefined);
      await session?.browser.close().catch(() => undefined);
    }
  }

  private async newSession(): Promise<BrowserSession> {
    const browser = await chromium.connectOverCDP(this.config.remoteWsEndpoint!, {
      timeout: this.config.navigationTimeoutMs,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      locale: "en-US",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    return { browser, context, page };
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

async function fillLikelyAmount(page: Page, amount?: number) {
  if (!amount) return;
  const amountText = String(amount);
  const selectors = [
    page.getByLabel(/amount|serving|quantity/i),
    page.locator("input[type='number']").first(),
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
  await page.getByText(meal, { exact: true }).click().catch(() => undefined);
}

async function fillLikelyName(page: Page, name: string) {
  const selectors = [
    page.getByLabel(/name|description/i),
    page.locator("input[type='text']").filter({ hasNotText: /Search/i }).first(),
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
  const search = page.locator('input[placeholder*="Search all foods"], input.gwt-TextBox.search-field').last();
  if ((await search.count().catch(() => 0)) === 0) {
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
    .filter((line) => !/^(SEARCH|All|Favorites|Common Foods|Beverages|Supplements|Brands|Restaurants|Custom)$/i.test(line))
    .map((line) => {
      const sourceMatch = line.match(/\b(NCCDB|USDA|Custom Food|CRDB|Restaurant|Brand)$/i);
      return {
        name: sourceMatch ? line.slice(0, sourceMatch.index).trim() : line,
        source: sourceMatch?.[1],
        raw: line,
      };
    })
    .filter((item, index, items) => items.findIndex((candidate) => candidate.name === item.name) === index)
    .slice(0, limit);
}

function compactText(text: string, maxLength: number) {
  const normalized = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
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
