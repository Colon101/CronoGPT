export interface CustomFoodNutrientDefinition {
  key: string;
  label: string;
  unit?: string;
  aliases?: string[];
}

export interface CustomFoodNutrientGroup {
  group: string;
  nutrients: CustomFoodNutrientDefinition[];
}

export const CUSTOM_FOOD_NUTRIENT_SCHEMA: CustomFoodNutrientGroup[] = [
  {
    group: "general",
    nutrients: [
      { key: "calories", label: "Energy", unit: "kcal", aliases: ["calorie", "energy", "kcal"] },
      { key: "kilojoules", label: "Kilojoules", unit: "kJ", aliases: ["kj"] },
      { key: "alcohol", label: "Alcohol", unit: "g" },
      { key: "ash", label: "Ash", unit: "g" },
      { key: "beta_hydroxybutyrate", label: "Beta-Hydroxybutyrate", unit: "g", aliases: ["bhb", "beta hydroxybutyrate"] },
      { key: "caffeine", label: "Caffeine", unit: "mg" },
      { key: "oxalate", label: "Oxalate", unit: "mg" },
      { key: "phytate", label: "Phytate", unit: "mg" },
      { key: "water", label: "Water", unit: "g" },
    ],
  },
  {
    group: "carbohydrates",
    nutrients: [
      { key: "total_carbs", label: "Total Carbs", unit: "g", aliases: ["carb", "carbs", "carbohydrate", "carbohydrates", "total carbohydrate", "total carbohydrates"] },
      { key: "fiber", label: "Fiber", unit: "g", aliases: ["dietary fiber"] },
      { key: "insoluble_fiber", label: "Insoluble Fiber", unit: "g" },
      { key: "soluble_fiber", label: "Soluble Fiber", unit: "g" },
      { key: "starch", label: "Starch", unit: "g" },
      { key: "sugars", label: "Sugars", unit: "g", aliases: ["sugar", "total sugar", "total sugars"] },
      { key: "allulose", label: "Allulose", unit: "g" },
      { key: "fructose", label: "Fructose", unit: "g" },
      { key: "galactose", label: "Galactose", unit: "g" },
      { key: "glucose", label: "Glucose", unit: "g" },
      { key: "lactose", label: "Lactose", unit: "g" },
      { key: "maltose", label: "Maltose", unit: "g" },
      { key: "sucrose", label: "Sucrose", unit: "g" },
      { key: "added_sugars", label: "Added Sugars", unit: "g", aliases: ["added sugar"] },
      { key: "sugar_alcohol", label: "Sugar Alcohol", unit: "g", aliases: ["sugar alcohols", "polyols"] },
    ],
  },
  {
    group: "lipids",
    nutrients: [
      { key: "fat", label: "Fat", unit: "g", aliases: ["total fat"] },
      { key: "monounsaturated", label: "Monounsaturated", unit: "g", aliases: ["monounsaturated fat", "mufa"] },
      { key: "polyunsaturated", label: "Polyunsaturated", unit: "g", aliases: ["polyunsaturated fat", "pufa"] },
      { key: "omega_3", label: "Omega-3", unit: "g", aliases: ["omega 3"] },
      { key: "ala", label: "ALA", unit: "g", aliases: ["alpha linolenic acid"] },
      { key: "dha", label: "DHA", unit: "g", aliases: ["docosahexaenoic acid"] },
      { key: "epa", label: "EPA", unit: "g", aliases: ["eicosapentaenoic acid"] },
      { key: "omega_6", label: "Omega-6", unit: "g", aliases: ["omega 6"] },
      { key: "aa", label: "AA", unit: "g", aliases: ["arachidonic acid"] },
      { key: "la", label: "LA", unit: "g", aliases: ["linoleic acid"] },
      { key: "saturated", label: "Saturated", unit: "g", aliases: ["saturated fat"] },
      { key: "trans_fats", label: "Trans-Fats", unit: "g", aliases: ["trans fat", "trans fats"] },
      { key: "cholesterol", label: "Cholesterol", unit: "mg" },
      { key: "phytosterol", label: "Phytosterol", unit: "mg", aliases: ["phytosterols"] },
    ],
  },
  {
    group: "protein_and_amino_acids",
    nutrients: [
      { key: "protein", label: "Protein", unit: "g" },
      { key: "alanine", label: "Alanine", unit: "g" },
      { key: "arginine", label: "Arginine", unit: "g" },
      { key: "aspartic_acid", label: "Aspartic acid", unit: "g", aliases: ["aspartate"] },
      { key: "cystine", label: "Cystine", unit: "g" },
      { key: "glutamic_acid", label: "Glutamic acid", unit: "g", aliases: ["glutamate"] },
      { key: "glycine", label: "Glycine", unit: "g" },
      { key: "histidine", label: "Histidine", unit: "g" },
      { key: "hydroxyproline", label: "Hydroxyproline", unit: "g" },
      { key: "isoleucine", label: "Isoleucine", unit: "g" },
      { key: "leucine", label: "Leucine", unit: "g" },
      { key: "lysine", label: "Lysine", unit: "g" },
      { key: "methionine", label: "Methionine", unit: "g" },
      { key: "phenylalanine", label: "Phenylalanine", unit: "g" },
      { key: "proline", label: "Proline", unit: "g" },
      { key: "serine", label: "Serine", unit: "g" },
      { key: "threonine", label: "Threonine", unit: "g" },
      { key: "tryptophan", label: "Tryptophan", unit: "g" },
      { key: "tyrosine", label: "Tyrosine", unit: "g" },
      { key: "valine", label: "Valine", unit: "g" },
    ],
  },
  {
    group: "vitamins",
    nutrients: [
      { key: "b1_thiamine", label: "B1 (Thiamine)", unit: "mg", aliases: ["b1", "thiamine", "vitamin b1"] },
      { key: "b2_riboflavin", label: "B2 (Riboflavin)", unit: "mg", aliases: ["b2", "riboflavin", "vitamin b2"] },
      { key: "b3_niacin", label: "B3 (Niacin)", unit: "mg", aliases: ["b3", "niacin", "vitamin b3"] },
      { key: "b5_pantothenic_acid", label: "B5 (Pantothenic Acid)", unit: "mg", aliases: ["b5", "pantothenic acid", "vitamin b5"] },
      { key: "b6_pyridoxine", label: "B6 (Pyridoxine)", unit: "mg", aliases: ["b6", "pyridoxine", "vitamin b6"] },
      { key: "b12_cobalamin", label: "B12 (Cobalamin)", unit: "mcg", aliases: ["b12", "cobalamin", "vitamin b12"] },
      { key: "biotin", label: "Biotin", unit: "mcg" },
      { key: "choline", label: "Choline", unit: "mg" },
      { key: "folate", label: "Folate", unit: "mcg" },
      { key: "folate_dfe", label: "Folate DFE", unit: "mcg" },
      { key: "folate_food", label: "Folate food", unit: "mcg" },
      { key: "folic_acid", label: "Folic acid", unit: "mcg" },
      { key: "vitamin_a", label: "Vitamin A", unit: "IU" },
      { key: "retinol", label: "Retinol", unit: "mcg" },
      { key: "retinol_activity_equivalent", label: "Retinol Activity Equivalent", unit: "mcg", aliases: ["rae"] },
      { key: "alpha_carotene", label: "Alpha-Carotene", unit: "mcg" },
      { key: "beta_carotene", label: "Beta-Carotene", unit: "mcg" },
      { key: "beta_cryptoxanthin", label: "Beta-Cryptoxanthin", unit: "mcg" },
      { key: "lycopene", label: "Lycopene", unit: "mcg" },
      { key: "lutein_zeaxanthin", label: "Lutein+Zeaxanthin", unit: "mcg", aliases: ["lutein", "zeaxanthin", "lutein zeaxanthin"] },
      { key: "vitamin_c", label: "Vitamin C", unit: "mg", aliases: ["ascorbic acid"] },
      { key: "vitamin_d", label: "Vitamin D", unit: "IU" },
      { key: "vitamin_e", label: "Vitamin E", unit: "mg" },
      { key: "alpha_tocopherol", label: "Alpha-Tocopherol", unit: "mg" },
      { key: "beta_tocopherol", label: "Beta-Tocopherol", unit: "mg" },
      { key: "delta_tocopherol", label: "Delta-Tocopherol", unit: "mg" },
      { key: "gamma_tocopherol", label: "Gamma-Tocopherol", unit: "mg" },
      { key: "vitamin_k", label: "Vitamin K", unit: "mcg" },
    ],
  },
  {
    group: "minerals",
    nutrients: [
      { key: "calcium", label: "Calcium", unit: "mg" },
      { key: "copper", label: "Copper", unit: "mg" },
      { key: "iron", label: "Iron", unit: "mg" },
      { key: "magnesium", label: "Magnesium", unit: "mg" },
      { key: "manganese", label: "Manganese", unit: "mg" },
      { key: "phosphorus", label: "Phosphorus", unit: "mg" },
      { key: "potassium", label: "Potassium", unit: "mg" },
      { key: "selenium", label: "Selenium", unit: "mcg" },
      { key: "sodium", label: "Sodium", unit: "mg" },
      { key: "zinc", label: "Zinc", unit: "mg" },
    ],
  },
];

const NUTRIENT_LOOKUP = new Map<string, string>();

for (const group of CUSTOM_FOOD_NUTRIENT_SCHEMA) {
  for (const nutrient of group.nutrients) {
    for (const alias of [nutrient.key, nutrient.label, ...(nutrient.aliases ?? [])]) {
      NUTRIENT_LOOKUP.set(normalizeNutrientKey(alias), nutrient.label);
    }
  }
}

export function customFoodNutrientLabelForKey(key: string) {
  const trimmed = key.trim();
  const normalized = normalizeNutrientKey(trimmed);
  if (!normalized) return undefined;
  return NUTRIENT_LOOKUP.get(normalized) ?? titleCaseNutrientLabel(trimmed);
}

export function customFoodNutrientSchemaSummary() {
  return CUSTOM_FOOD_NUTRIENT_SCHEMA.map((group) => ({
    group: group.group,
    keys: group.nutrients.map((nutrient) => nutrient.key),
    displayLabels: group.nutrients.map((nutrient) => nutrient.label),
  }));
}

function normalizeNutrientKey(value: string) {
  return value
    .toLowerCase()
    .replace(/µ/g, "u")
    .replace(/&/g, " and ")
    .replace(/\+/g, " ")
    .replace(/[()[\],]/g, " ")
    .replace(/[_/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseNutrientLabel(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      if (/^(ala|dha|epa|aa|la|dfe|b\d+|iu|kcal|kj)$/i.test(word)) return word.toUpperCase();
      if (lower === "and") return "+";
      return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}
