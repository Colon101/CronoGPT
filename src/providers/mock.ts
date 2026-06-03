import type {
  BiometricLogInput,
  CustomFoodDeleteInput,
  CustomFoodDuplicateInput,
  CustomFoodInput,
  CustomFoodListInput,
  CustomFoodRetireInput,
  CustomFoodUpdateInput,
  DateRangeInput,
  ExerciseLogInput,
  ExportDataInput,
  FastInput,
  FoodLogInput,
  NoteLogInput,
  RecipeDeleteInput,
  RecipeInput,
  RecipeRetireInput,
  RecipeUpdateInput,
  RepeatItemInput,
  SearchFoodsInput,
  TargetsInput,
} from "../domain.js";
import { BaseCronometerProvider } from "./base.js";

function requestedDate(input: DateRangeInput): string {
  return input.date ?? input.startDate ?? new Date().toISOString().slice(0, 10);
}

export class MockCronometerProvider extends BaseCronometerProvider {
  constructor() {
    super("mock", "mock");
  }

  async getDailySummary(input: DateRangeInput) {
    const date = requestedDate(input);
    return this.result("get_daily_summary", "dry_run", {
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
    const date = requestedDate(input);
    return this.result("list_food_entries", "dry_run", {
      date,
      entries: [
        { id: "sample-food-1", meal: "Breakfast", name: "Greek yogurt", calories: 190, protein_g: 20 },
        { id: "sample-food-2", meal: "Lunch", name: "Rice bowl", calories: 620, protein_g: 38 },
      ],
    });
  }

  async listBiometrics(input: DateRangeInput) {
    const date = requestedDate(input);
    return this.result("list_biometrics", "dry_run", {
      date,
      entries: [{ id: "sample-bio-1", metric: "Weight", value: 78.4, unit: "kg" }],
    });
  }

  async listExercises(input: DateRangeInput) {
    const date = requestedDate(input);
    return this.result("list_exercises", "dry_run", {
      date,
      entries: [{ id: "sample-exercise-1", name: "Walking", minutes: 45, calories: 210 }],
    });
  }

  async listNotes(input: DateRangeInput) {
    const date = requestedDate(input);
    return this.result("list_notes", "dry_run", {
      date,
      entries: [{ id: "sample-note-1", note: "Energy felt steady after lunch." }],
    });
  }

  async searchFoods(input: SearchFoodsInput) {
    return this.result("search_foods", "dry_run", {
      query: input.query,
      results: [
        { id: "sample-result-1", name: `${input.query} - generic`, source: "mock" },
        { id: "sample-result-2", name: `${input.query} - branded`, source: "mock" },
      ].slice(0, input.limit ?? 10),
    });
  }

  async logFood(input: FoodLogInput) {
    return this.dryRunWrite("log_food", input);
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
    return this.result("list_custom_foods", "dry_run", {
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
    return this.result("find_duplicate_custom_foods", "dry_run", {
      input,
      matches: [],
      duplicateGroups: [],
    });
  }

  async createCustomFood(input: CustomFoodInput) {
    return this.dryRunWrite("create_custom_food", input);
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
    return this.result("list_custom_recipes", "dry_run", {
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
    return this.result("get_targets", "dry_run", {
      date: requestedDate(input),
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
}
