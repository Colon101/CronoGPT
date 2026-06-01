import type {
  BiometricLogInput,
  Capability,
  CronometerProvider,
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
  BackendMode,
} from "../domain.js";
import { capabilitiesForMode } from "../features.js";

export class BaseCronometerProvider implements CronometerProvider {
  constructor(
    public readonly name: string,
    public readonly mode: BackendMode,
  ) {}

  async capabilities(): Promise<ProviderResult<Capability[]>> {
    return this.result("cronometer_capabilities", "ok", capabilitiesForMode(this.mode));
  }

  async readFeaturePage(feature: string, hash: string, input: unknown): Promise<ProviderResult> {
    return this.unsupported(feature, { hash, input });
  }

  async getDailySummary(input: DateRangeInput): Promise<ProviderResult> {
    return this.unsupported("get_daily_summary", input);
  }

  async listFoodEntries(input: DateRangeInput): Promise<ProviderResult> {
    return this.unsupported("list_food_entries", input);
  }

  async listBiometrics(input: DateRangeInput): Promise<ProviderResult> {
    return this.unsupported("list_biometrics", input);
  }

  async listExercises(input: DateRangeInput): Promise<ProviderResult> {
    return this.unsupported("list_exercises", input);
  }

  async listNotes(input: DateRangeInput): Promise<ProviderResult> {
    return this.unsupported("list_notes", input);
  }

  async searchFoods(input: SearchFoodsInput): Promise<ProviderResult> {
    return this.unsupported("search_foods", input);
  }

  async resolveRecipeIngredients(input: ResolveRecipeIngredientsInput): Promise<ProviderResult> {
    const limit = input.limitPerIngredient ?? 5;
    const resolved = [];
    for (const ingredient of input.ingredients) {
      const result = await this.searchFoods({ query: ingredient.query, limit });
      resolved.push({
        ingredient,
        status: result.status,
        warning: result.warning,
        matches: result.data,
      });
    }
    return this.result("resolve_recipe_ingredients", "dry_run", {
      recipeName: input.recipeName,
      resolved,
      nextStep: "Pick the matching Cronometer food for each ingredient, then call create_recipe with confirmed=true when ready to write.",
    });
  }

  async logFood(input: FoodLogInput): Promise<ProviderResult> {
    return this.unsupported("log_food", input);
  }

  async logExercise(input: ExerciseLogInput): Promise<ProviderResult> {
    return this.unsupported("log_exercise", input);
  }

  async logBiometric(input: BiometricLogInput): Promise<ProviderResult> {
    return this.unsupported("log_biometric", input);
  }

  async logNote(input: NoteLogInput): Promise<ProviderResult> {
    return this.unsupported("log_note", input);
  }

  async createCustomFood(input: CustomFoodInput): Promise<ProviderResult> {
    return this.unsupported("create_custom_food", input);
  }

  async createRecipe(input: RecipeInput): Promise<ProviderResult> {
    return this.unsupported("create_recipe", input);
  }

  async getTargets(input: DateRangeInput): Promise<ProviderResult> {
    return this.unsupported("get_targets", input);
  }

  async setTargets(input: TargetsInput): Promise<ProviderResult> {
    return this.unsupported("set_targets", input);
  }

  async exportData(input: ExportDataInput): Promise<ProviderResult> {
    return this.unsupported("export_data", input);
  }

  async startFast(input: FastInput): Promise<ProviderResult> {
    return this.unsupported("start_fast", input);
  }

  async stopFast(input: FastInput): Promise<ProviderResult> {
    return this.unsupported("stop_fast", input);
  }

  async scheduleRepeatItem(input: RepeatItemInput): Promise<ProviderResult> {
    return this.unsupported("schedule_repeat_item", input);
  }

  protected result<T>(
    feature: string,
    status: ProviderResult<T>["status"],
    data?: T,
    warning?: string,
    source?: string,
  ): ProviderResult<T> {
    return {
      provider: this.name,
      mode: this.mode,
      feature,
      status,
      data,
      warning,
      source,
    };
  }

  protected unsupported(feature: string, input?: unknown): ProviderResult {
    return this.result(feature, "unsupported", { input }, `${this.name} does not implement ${feature}.`);
  }
}
