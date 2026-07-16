export type BackendMode = "mock" | "terra" | "browser";

export type ProviderStatus =
  | "ok"
  | "dry_run"
  | "accepted"
  | "written"
  | "already_exists"
  | "busy"
  | "not_written_login_paused"
  | "not_written_ambiguous"
  | "not_written_not_found"
  | "possibly_written_verify_failed"
  | "not_configured"
  | "unsupported"
  | "needs_manual_step"
  | "error";

export type FeatureGroup =
  | "capabilities"
  | "diary"
  | "logging"
  | "foods"
  | "targets"
  | "reports"
  | "fasting"
  | "scheduling";

export interface DateRangeInput {
  date?: string;
  startDate?: string;
  endDate?: string;
}

export interface FoodPortionDefinition {
  name: string;
  weightGrams: number;
}

export interface CustomFoodServingPreview {
  servingSize?: string;
  servingSizeSource: "provided" | "preferred_gram_default" | "missing";
  portions: FoodPortionDefinition[];
  valid: boolean;
  issues: string[];
}

/**
 * Normalizes custom-food portions without coupling domain validation to browser UI selectors.
 * A gram-based primary serving keeps named package portions unambiguous; legacy callers may
 * continue to provide any explicit servingSize when they do not use portions.
 */
export function customFoodServingPreview(input: {
  servingSize?: string;
  portions?: FoodPortionDefinition[];
}): CustomFoodServingPreview {
  const portions = (input.portions ?? []).map((portion) => ({
    name: portion.name?.replace(/\s+/g, " ").trim() ?? "",
    weightGrams: portion.weightGrams,
  }));
  const seenNames = new Set<string>();
  const issues: string[] = [];
  for (const portion of portions) {
    const normalizedName = portion.name.toLowerCase();
    if (!portion.name) issues.push("Custom-food portion name must not be blank.");
    if (!Number.isFinite(portion.weightGrams) || portion.weightGrams <= 0) {
      issues.push(`Custom-food portion ${JSON.stringify(portion.name || "<unnamed>")} weightGrams must be a finite number greater than zero.`);
    }
    if (normalizedName && seenNames.has(normalizedName)) {
      issues.push(`Custom-food portion name ${JSON.stringify(portion.name)} was supplied more than once.`);
    }
    seenNames.add(normalizedName);
  }
  const providedServingSize = input.servingSize?.replace(/\s+/g, " ").trim();
  const servingSize = providedServingSize || (portions.length > 0 ? "1 g" : undefined);
  if (portions.length > 0 && providedServingSize && !/^1\s*(?:g|gram|grams)$/i.test(providedServingSize)) {
    issues.push("Custom foods with named portions require a 1 g base servingSize so every portion weight remains unambiguous.");
  }
  if (portions.some((portion) => /^(?:g|gram|grams)$/i.test(portion.name))) {
    issues.push("Do not add g as a named portion; servingSize 1 g is the nutrition basis.");
  }
  return {
    servingSize,
    servingSizeSource: providedServingSize ? "provided" : portions.length > 0 ? "preferred_gram_default" : "missing",
    portions,
    valid: issues.length === 0,
    issues,
  };
}

export interface ExpectedExistingMatchCountPreview {
  expectedExistingMatchCount?: number;
  valid: boolean;
  issues: string[];
}

export function expectedExistingMatchCountPreview(expectedExistingMatchCount?: number): ExpectedExistingMatchCountPreview {
  const valid = expectedExistingMatchCount === undefined
    || (Number.isInteger(expectedExistingMatchCount) && expectedExistingMatchCount >= 0);
  return {
    expectedExistingMatchCount,
    valid,
    issues: valid ? [] : ["expectedExistingMatchCount must be a non-negative integer."],
  };
}

export interface CustomFoodTransactionPreview extends CustomFoodServingPreview {
  expectedExistingMatchCount: ExpectedExistingMatchCountPreview;
  transactionDigest: string;
}

/** Stable browser-independent preview for create, create-and-log, and update inputs. */
export function customFoodTransactionPreview(input: {
  name?: string;
  servingSize?: string;
  portions?: FoodPortionDefinition[];
  expectedExistingMatchCount?: number;
  requireServingSize?: boolean;
}): CustomFoodTransactionPreview {
  const serving = customFoodServingPreview(input);
  const expectedExistingMatchCount = expectedExistingMatchCountPreview(input.expectedExistingMatchCount);
  const servingSizeIssues = input.requireServingSize && !serving.servingSize
    ? ["Custom food servingSize is required unless portions are supplied."]
    : [];
  const transactionDigest = stableTransactionDigest({
    name: normalizeTransactionText(input.name),
    servingSize: serving.servingSize ?? null,
    portions: serving.portions.map((portion) => ({ name: normalizeTransactionText(portion.name), weightGrams: portion.weightGrams })),
    expectedExistingMatchCount: input.expectedExistingMatchCount ?? null,
  });
  return {
    ...serving,
    valid: serving.valid && expectedExistingMatchCount.valid && servingSizeIssues.length === 0,
    issues: [...serving.issues, ...expectedExistingMatchCount.issues, ...servingSizeIssues],
    expectedExistingMatchCount,
    transactionDigest,
  };
}

/** Stable digest for food writes, including optional optimistic-concurrency expectations. */
export function foodTransactionDigest(input: Pick<FoodLogInput, "date" | "meal" | "query" | "selectedName" | "selectedSource" | "amount" | "unit" | "portion" | "timestamp" | "expectedExistingMatchCount">) {
  return stableTransactionDigest({
    date: input.date ?? null,
    meal: normalizeTransactionText(input.meal),
    query: normalizeTransactionText(input.query),
    selectedName: normalizeTransactionText(input.selectedName),
    selectedSource: normalizeTransactionText(input.selectedSource),
    amount: input.amount ?? null,
    unit: normalizeTransactionText(input.unit),
    portion: input.portion
      ? { kind: input.portion.kind, name: normalizeTransactionText(input.portion.portion.name), weightGrams: input.portion.portion.weightGrams, count: input.portion.count ?? 1 }
      : null,
    timestamp: input.timestamp ?? null,
    expectedExistingMatchCount: input.expectedExistingMatchCount ?? null,
  });
}

function normalizeTransactionText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function stableTransactionDigest(value: unknown) {
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `txn-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface WholePackagePortion {
  kind: "whole_package";
  portion: FoodPortionDefinition;
  count?: number;
}

export interface FoodLogInput {
  date?: string;
  meal?: string;
  query: string;
  selectedName?: string;
  selectedSource?: string;
  amount?: number;
  unit?: string;
  portion?: WholePackagePortion;
  timestamp?: string;
  matchPolicy?: "high_confidence" | "selected_only";
  searchScope?: "auto" | "all" | "custom" | "favorites";
  /**
   * Read-only preflight count for the exact requested diary row. The browser transaction
   * must refuse a changed count rather than assuming its prior lookup is still current.
   */
  expectedExistingMatchCount?: number;
  dryRun?: boolean;
  confirmed?: boolean;
  idempotencyKey?: string;
  waitForCompletionSeconds?: number;
}

export interface FoodLogBatchInput {
  date?: string;
  meal?: string;
  items: FoodLogInput[];
  /** Expected exact-row counts, in the same order as items, from a prior preflight lookup. */
  expectedExistingMatchCount?: number[];
  dryRun?: boolean;
  confirmed?: boolean;
  idempotencyKey?: string;
  stopOnFirstFailure?: boolean;
  waitForCompletionSeconds?: number;
}

export interface DiaryFoodDeleteInput {
  date?: string;
  meal?: string;
  name: string;
  amount?: number;
  unit?: string;
  deleteCount?: number;
  confirmName?: string;
  dryRun?: boolean;
  confirmed?: boolean;
  waitForCompletionSeconds?: number;
}

export interface ExerciseLogInput {
  date?: string;
  name: string;
  minutes?: number;
  calories?: number;
  timestamp?: string;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface BiometricLogInput {
  date?: string;
  metric: string;
  value: number;
  unit?: string;
  timestamp?: string;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface NoteLogInput {
  date?: string;
  note: string;
  timestamp?: string;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface SearchFoodsInput {
  query: string;
  limit?: number;
  searchScope?: "auto" | "all" | "custom" | "favorites";
  selectedSource?: string;
}

export interface StabilityCheckInput {
  foodQuery?: string;
  includeFoodSearch?: boolean;
}

export interface RecipeIngredientInput {
  query: string;
  selectedName?: string;
  selectedSource?: string;
  amount?: number;
  unit?: string;
}

export interface ResolveRecipeIngredientsInput {
  recipeName?: string;
  ingredients: RecipeIngredientInput[];
  limitPerIngredient?: number;
  maxSeconds?: number;
}

export interface RecipeInput {
  name: string;
  ingredients: RecipeIngredientInput[];
  servings?: number;
  servingName?: string;
  cookedWeight?: number;
  cookedWeightUnit?: string;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface CustomRecipeSelectorInput {
  recipeId?: string;
  name?: string;
}

export interface RecipeDeleteInput extends CustomRecipeSelectorInput {
  confirmName?: string;
  ifUsed?: "stop" | "retire" | "force";
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface RecipeUpdateInput extends CustomRecipeSelectorInput {
  newName?: string;
  ingredientsToAdd?: RecipeIngredientInput[];
  servings?: number;
  servingName?: string;
  cookedWeight?: number;
  cookedWeightUnit?: string;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface RecipeRetireInput extends CustomRecipeSelectorInput {
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface CustomFoodInput {
  name: string;
  /** Defaults to the stable one-gram base serving when named portions are supplied. */
  servingSize?: string;
  /** Additional exact name-to-gram serving mappings to create on the private food. */
  portions?: FoodPortionDefinition[];
  nutrients?: Record<string, number>;
  barcode?: string;
  duplicatePolicy?: "fail" | "update_existing" | "create_new";
  /** Optimistic-concurrency count from a prior exact-name custom-food lookup. */
  expectedExistingMatchCount?: number;
  dryRun?: boolean;
  confirmed?: boolean;
  waitForCompletionSeconds?: number;
}

export interface CustomFoodAndLogInput extends CustomFoodInput {
  date?: string;
  meal: string;
  amount?: number;
  unit?: string;
  portion?: WholePackagePortion;
  timestamp?: string;
  nutritionSource?: string;
}

export interface CustomFoodSelectorInput {
  foodId?: string;
  name?: string;
}

export interface CustomFoodListInput {
  query?: string;
  includeDetails?: boolean;
  maxDetails?: number;
}

export interface CustomFoodUpdateInput extends CustomFoodSelectorInput {
  newName?: string;
  servingSize?: string;
  portions?: FoodPortionDefinition[];
  nutrients?: Record<string, number>;
  barcode?: string;
  /** Optimistic-concurrency count from a prior exact-name custom-food lookup. */
  expectedExistingMatchCount?: number;
  dryRun?: boolean;
  confirmed?: boolean;
  waitForCompletionSeconds?: number;
}

export interface CustomFoodDeleteInput extends CustomFoodSelectorInput {
  confirmName?: string;
  ifUsed?: "stop" | "retire" | "force";
  dryRun?: boolean;
  confirmed?: boolean;
  waitForCompletionSeconds?: number;
}

export interface CustomFoodRetireInput extends CustomFoodSelectorInput {
  retiredName?: string;
  dryRun?: boolean;
  confirmed?: boolean;
  waitForCompletionSeconds?: number;
}

export interface CustomFoodDuplicateInput {
  name: string;
  maxDetails?: number;
}

export interface TargetsInput {
  date?: string;
  targets?: Record<string, number>;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface ExportDataInput extends DateRangeInput {
  include?: Array<"servings" | "exercises" | "biometrics" | "notes" | "fasting">;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface FastInput {
  date?: string;
  startTime?: string;
  endTime?: string;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface RepeatItemInput {
  sourceEntryId?: string;
  query?: string;
  meal?: string;
  schedule: string;
  dryRun?: boolean;
  confirmed?: boolean;
}

export type UiFlowSection =
  | "diary"
  | "customFoods"
  | "customMeals"
  | "customRecipes"
  | "targetsProfile"
  | "charts"
  | "nutritionReport"
  | "printReport"
  | "snapshots"
  | "fasting"
  | "repeatItems"
  | "macroScheduler"
  | "displaySettings"
  | "devices"
  | "sharing"
  | "account";

export interface UiFlowStep {
  action: "clickText" | "fillLabel" | "fillPlaceholder" | "press" | "wait" | "read";
  text?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  key?: "Enter" | "Escape" | "Tab" | "ArrowDown" | "ArrowUp";
  ms?: number;
  exact?: boolean;
}

export interface UiFlowInput {
  section: UiFlowSection;
  steps: UiFlowStep[];
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface Capability {
  id: string;
  group: FeatureGroup;
  title: string;
  preferredBackend: "terra" | "csv" | "browser" | "manual";
  currentBackendStatus: ProviderStatus;
  notes: string;
}

export interface ProviderResult<T = unknown> {
  provider: string;
  mode: BackendMode;
  feature: string;
  status: ProviderStatus;
  data?: T;
  warning?: string;
  source?: string;
}

export interface CronometerProvider {
  readonly name: string;
  readonly mode: BackendMode;
  capabilities(): Promise<ProviderResult<Capability[]>>;
  runtimeStatus(): Promise<ProviderResult>;
  getOperation(operationId: string): Promise<ProviderResult>;
  refreshSession(): Promise<ProviderResult>;
  stabilityCheck(input: StabilityCheckInput): Promise<ProviderResult>;
  readFeaturePage(feature: string, hash: string, input: unknown): Promise<ProviderResult>;
  getDailySummary(input: DateRangeInput): Promise<ProviderResult>;
  listFoodEntries(input: DateRangeInput): Promise<ProviderResult>;
  listBiometrics(input: DateRangeInput): Promise<ProviderResult>;
  listExercises(input: DateRangeInput): Promise<ProviderResult>;
  listNotes(input: DateRangeInput): Promise<ProviderResult>;
  searchFoods(input: SearchFoodsInput): Promise<ProviderResult>;
  resolveRecipeIngredients(input: ResolveRecipeIngredientsInput): Promise<ProviderResult>;
  logFood(input: FoodLogInput): Promise<ProviderResult>;
  logFoods(input: FoodLogBatchInput): Promise<ProviderResult>;
  deleteDiaryFoodEntry(input: DiaryFoodDeleteInput): Promise<ProviderResult>;
  logExercise(input: ExerciseLogInput): Promise<ProviderResult>;
  logBiometric(input: BiometricLogInput): Promise<ProviderResult>;
  logNote(input: NoteLogInput): Promise<ProviderResult>;
  listCustomFoods(input: CustomFoodListInput): Promise<ProviderResult>;
  findDuplicateCustomFoods(input: CustomFoodDuplicateInput): Promise<ProviderResult>;
  createCustomFood(input: CustomFoodInput): Promise<ProviderResult>;
  createAndLogCustomFood(input: CustomFoodAndLogInput): Promise<ProviderResult>;
  updateCustomFood(input: CustomFoodUpdateInput): Promise<ProviderResult>;
  deleteCustomFood(input: CustomFoodDeleteInput): Promise<ProviderResult>;
  retireCustomFood(input: CustomFoodRetireInput): Promise<ProviderResult>;
  listCustomRecipes(input: CustomFoodListInput): Promise<ProviderResult>;
  createRecipe(input: RecipeInput): Promise<ProviderResult>;
  updateCustomRecipe(input: RecipeUpdateInput): Promise<ProviderResult>;
  deleteCustomRecipe(input: RecipeDeleteInput): Promise<ProviderResult>;
  retireCustomRecipe(input: RecipeRetireInput): Promise<ProviderResult>;
  getTargets(input: DateRangeInput): Promise<ProviderResult>;
  setTargets(input: TargetsInput): Promise<ProviderResult>;
  exportData(input: ExportDataInput): Promise<ProviderResult>;
  startFast(input: FastInput): Promise<ProviderResult>;
  stopFast(input: FastInput): Promise<ProviderResult>;
  scheduleRepeatItem(input: RepeatItemInput): Promise<ProviderResult>;
  runUiFlow(input: UiFlowInput): Promise<ProviderResult>;
}
