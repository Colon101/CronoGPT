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

export interface FoodLogInput {
  date?: string;
  meal?: string;
  query: string;
  selectedName?: string;
  selectedSource?: string;
  amount?: number;
  unit?: string;
  timestamp?: string;
  matchPolicy?: "high_confidence" | "selected_only" | "best_effort";
  searchScope?: "auto" | "all" | "custom" | "favorites";
  dryRun?: boolean;
  confirmed?: boolean;
  idempotencyKey?: string;
}

export interface FoodLogBatchInput {
  date?: string;
  meal?: string;
  items: FoodLogInput[];
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
  confirmName?: string;
  dryRun?: boolean;
  confirmed?: boolean;
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
  retiredName?: string;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface CustomFoodInput {
  name: string;
  servingSize?: string;
  nutrients?: Record<string, number>;
  barcode?: string;
  duplicatePolicy?: "fail" | "update_existing" | "create_new";
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface CustomFoodAndLogInput extends CustomFoodInput {
  date?: string;
  meal?: string;
  amount?: number;
  unit?: string;
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
  nutrients?: Record<string, number>;
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface CustomFoodDeleteInput extends CustomFoodSelectorInput {
  confirmName?: string;
  ifUsed?: "stop" | "retire" | "force";
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface CustomFoodRetireInput extends CustomFoodSelectorInput {
  retiredName?: string;
  dryRun?: boolean;
  confirmed?: boolean;
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
