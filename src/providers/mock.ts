import type {
  BiometricLogInput,
  CustomFoodDeleteInput,
  CustomFoodAndLogInput,
  CustomFoodDuplicateInput,
  CustomFoodInput,
  CustomFoodListInput,
  CustomFoodRetireInput,
  CustomFoodUpdateInput,
  DateRangeInput,
  ExerciseLogInput,
  ExportDataInput,
  FastInput,
  FoodLogBatchInput,
  FoodLogInput,
  NoteLogInput,
  RecipeDeleteInput,
  RecipeInput,
  RecipeRetireInput,
  ResolveRecipeIngredientsInput,
  RecipeUpdateInput,
  RepeatItemInput,
  SearchFoodsInput,
  StabilityCheckInput,
  TargetsInput,
} from "../domain.js";
import { isoDateInTimeZone, systemClock, type Clock } from "../determinism.js";
import { BaseCronometerProvider } from "./base.js";

export interface MockConfig {
  clock?: Clock;
  timeZone?: string;
}

export class MockCronometerProvider extends BaseCronometerProvider {
  private readonly clock: Clock;
  private readonly timeZone: string;

  constructor(config: MockConfig = {}) {
    super("mock", "mock");
    this.clock = config.clock ?? systemClock;
    this.timeZone = config.timeZone ?? "UTC";
  }

  async stabilityCheck(input: StabilityCheckInput) {
    return this.fixtureRead("cronometer_stability_check", {
      input,
      provider: this.name,
      mode: this.mode,
      ready: true,
    });
  }

  async getDailySummary(input: DateRangeInput) {
    const date = this.requestedDate(input);
    return this.fixtureRead("get_daily_summary", {
      date,
      calories: { consumed: 2140, burned: 640, net: 1500 },
      macros: { protein_g: 142, carbs_g: 188, fat_g: 72 },
      highlightedNutrients: [
        { name: "Fiber", amount: 31, unit: "g", targetPercent: 103 },
        { name: "Magnesium", amount: 390, unit: "mg", targetPercent: 93 },
      ],
    });
  }

  async listFoodEntries(input: DateRangeInput) {
    const date = this.requestedDate(input);
    return this.fixtureRead("list_food_entries", {
      date,
      entries: [
        { id: "sample-food-1", meal: "Breakfast", name: "Greek yogurt", calories: 190, protein_g: 20 },
        { id: "sample-food-2", meal: "Lunch", name: "Rice bowl", calories: 620, protein_g: 38 },
      ],
    });
  }

  async listBiometrics(input: DateRangeInput) {
    const date = this.requestedDate(input);
    return this.fixtureRead("list_biometrics", {
      date,
      entries: [{ id: "sample-bio-1", metric: "Weight", value: 78.4, unit: "kg" }],
    });
  }

  async listExercises(input: DateRangeInput) {
    const date = this.requestedDate(input);
    return this.fixtureRead("list_exercises", {
      date,
      entries: [{ id: "sample-exercise-1", name: "Walking", minutes: 45, calories: 210 }],
    });
  }

  async listNotes(input: DateRangeInput) {
    const date = this.requestedDate(input);
    return this.fixtureRead("list_notes", {
      date,
      entries: [{ id: "sample-note-1", note: "Energy felt steady after lunch." }],
    });
  }

  async searchFoods(input: SearchFoodsInput) {
    return this.fixtureRead("search_foods", {
      query: input.query,
      searchScope: input.searchScope ?? "auto",
      selectedSource: input.selectedSource,
      results: [
        { id: "sample-result-1", name: `${input.query} - generic`, source: "mock" },
        { id: "sample-result-2", name: `${input.query} - branded`, source: "mock" },
      ].slice(0, input.limit ?? 10),
    });
  }

  async resolveRecipeIngredients(input: ResolveRecipeIngredientsInput) {
    const result = await super.resolveRecipeIngredients(input);
    return {
      ...result,
      status: "ok" as const,
      source: "mock-fixture",
    };
  }

  async logFood(input: FoodLogInput) {
    return this.dryRunWrite("log_food", input);
  }

  async logFoods(input: FoodLogBatchInput) {
    return this.dryRunWrite("log_foods", input);
  }

  async logExercise(input: ExerciseLogInput) {
    return this.dryRunWrite("log_exercise", input);
  }

  async logBiometric(input: BiometricLogInput) {
    return this.dryRunWrite("log_biometric", input);
  }

  async logNote(input: NoteLogInput) {
    return this.dryRunWrite("log_note", input);
  }

  async listCustomFoods(input: CustomFoodListInput) {
    return this.fixtureRead("list_custom_foods", {
      input,
      foods: [
        {
          foodId: "sample-custom-food-1",
          name: "Sweetango Gold",
          servingSize: "100 g",
          nutrients: { Energy: { value: 19, unit: "kcal" }, "Total Carbs": { value: 100, unit: "g" } },
        },
      ],
    });
  }

  async findDuplicateCustomFoods(input: CustomFoodDuplicateInput) {
    return this.fixtureRead("find_duplicate_custom_foods", {
      input,
      matches: [],
      duplicateGroups: [],
    });
  }

  async createCustomFood(input: CustomFoodInput) {
    return this.dryRunWrite("create_custom_food", input);
  }

  async createAndLogCustomFood(input: CustomFoodAndLogInput) {
    return this.dryRunWrite("create_and_log_custom_food", input);
  }

  async updateCustomFood(input: CustomFoodUpdateInput) {
    return this.dryRunWrite("update_custom_food", input);
  }

  async deleteCustomFood(input: CustomFoodDeleteInput) {
    return this.dryRunWrite("delete_custom_food", input);
  }

  async retireCustomFood(input: CustomFoodRetireInput) {
    return this.dryRunWrite("retire_custom_food", input);
  }

  async listCustomRecipes(input: CustomFoodListInput) {
    return this.fixtureRead("list_custom_recipes", {
      input,
      recipes: [{ recipeId: "sample-custom-recipe-1", name: "Protein cookie" }],
    });
  }

  async createRecipe(input: RecipeInput) {
    return this.dryRunWrite("create_recipe", input);
  }

  async updateCustomRecipe(input: RecipeUpdateInput) {
    return this.dryRunWrite("update_custom_recipe", input);
  }

  async deleteCustomRecipe(input: RecipeDeleteInput) {
    return this.dryRunWrite("delete_custom_recipe", input);
  }

  async retireCustomRecipe(input: RecipeRetireInput) {
    return this.dryRunWrite("retire_custom_recipe", input);
  }

  async getTargets(input: DateRangeInput) {
    return this.fixtureRead("get_targets", {
      date: this.requestedDate(input),
      targets: { calories: 2300, protein_g: 150, carbs_g: 230, fat_g: 75 },
    });
  }

  async setTargets(input: TargetsInput) {
    return this.dryRunWrite("set_targets", input);
  }

  async exportData(input: ExportDataInput) {
    return this.result("export_data", "dry_run", {
      request: input,
      nextStep: "Use Cronometer web Account Settings to export CSV, then add a CSV parser provider.",
    });
  }

  async startFast(input: FastInput) {
    return this.dryRunWrite("start_fast", input);
  }

  async stopFast(input: FastInput) {
    return this.dryRunWrite("stop_fast", input);
  }

  async scheduleRepeatItem(input: RepeatItemInput) {
    return this.dryRunWrite("schedule_repeat_item", input);
  }

  private dryRunWrite(feature: string, input: unknown) {
    return this.result(
      feature,
      "dry_run",
      { input },
      "Mock backend did not write to Cronometer. Configure Terra or browser automation for real data.",
    );
  }

  private fixtureRead<T>(feature: string, data: T) {
    return this.result(feature, "ok", data, undefined, "mock-fixture");
  }

  private requestedDate(input: DateRangeInput) {
    return input.date ?? input.startDate ?? isoDateInTimeZone(this.timeZone, this.clock());
  }
}
