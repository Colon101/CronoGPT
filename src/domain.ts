export type BackendMode = "mock" | "terra" | "browser";

export type ProviderStatus =
  | "ok"
  | "dry_run"
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
  amount?: number;
  unit?: string;
  timestamp?: string;
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

export interface RecipeIngredientInput {
  query: string;
  selectedName?: string;
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
  dryRun?: boolean;
  confirmed?: boolean;
}

export interface CustomFoodInput {
  name: string;
  servingSize?: string;
  nutrients?: Record<string, number>;
  barcode?: string;
  dryRun?: boolean;
  confirmed?: boolean;
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
  getDailySummary(input: DateRangeInput): Promise<ProviderResult>;
  listFoodEntries(input: DateRangeInput): Promise<ProviderResult>;
  listBiometrics(input: DateRangeInput): Promise<ProviderResult>;
  listExercises(input: DateRangeInput): Promise<ProviderResult>;
  listNotes(input: DateRangeInput): Promise<ProviderResult>;
  searchFoods(input: SearchFoodsInput): Promise<ProviderResult>;
  resolveRecipeIngredients(input: ResolveRecipeIngredientsInput): Promise<ProviderResult>;
  logFood(input: FoodLogInput): Promise<ProviderResult>;
  logExercise(input: ExerciseLogInput): Promise<ProviderResult>;
  logBiometric(input: BiometricLogInput): Promise<ProviderResult>;
  logNote(input: NoteLogInput): Promise<ProviderResult>;
  createCustomFood(input: CustomFoodInput): Promise<ProviderResult>;
  createRecipe(input: RecipeInput): Promise<ProviderResult>;
  getTargets(input: DateRangeInput): Promise<ProviderResult>;
  setTargets(input: TargetsInput): Promise<ProviderResult>;
  exportData(input: ExportDataInput): Promise<ProviderResult>;
  startFast(input: FastInput): Promise<ProviderResult>;
  stopFast(input: FastInput): Promise<ProviderResult>;
  scheduleRepeatItem(input: RepeatItemInput): Promise<ProviderResult>;
}
