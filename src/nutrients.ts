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
      { key: "total_carbs", label: "Total Carbs", unit: "g", aliases: ["carb", "carbs", "carbs_g", "carbohydrate", "carbohydrates", "carbohydrates_g", "total carbohydrate", "total carbohydrates", "net_carbs", "net carbs", "net carbohydrate", "net carbohydrates", "available carbs", "available carbohydrates"] },
      { key: "fiber", label: "Fiber", unit: "g", aliases: ["dietary fiber", "fiber_g"] },
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
      { key: "fat", label: "Fat", unit: "g", aliases: ["fat_g", "total fat"] },
      { key: "monounsaturated", label: "Monounsaturated", unit: "g", aliases: ["monounsaturated fat", "mufa"] },
      { key: "polyunsaturated", label: "Polyunsaturated", unit: "g", aliases: ["polyunsaturated fat", "pufa"] },
      { key: "omega_3", label: "Omega-3", unit: "g", aliases: ["omega 3", "omega-3", "n3", "n-3"] },
      { key: "ala", label: "ALA", unit: "g", aliases: ["alpha linolenic acid", "alpha-linolenic acid", "omega 3 ala", "omega-3 ala", "omega_3_ala", "18:3 n-3", "18:3n3"] },
      { key: "dha", label: "DHA", unit: "g", aliases: ["docosahexaenoic acid", "docosahexaenoate", "omega 3 dha", "omega-3 dha", "omega_3_dha", "22:6 n-3", "22:6n3"] },
      { key: "epa", label: "EPA", unit: "g", aliases: ["eicosapentaenoic acid", "eicosapentaenoate", "omega 3 epa", "omega-3 epa", "omega_3_epa", "20:5 n-3", "20:5n3"] },
      { key: "omega_6", label: "Omega-6", unit: "g", aliases: ["omega 6", "omega-6", "n6", "n-6"] },
      { key: "aa", label: "AA", unit: "g", aliases: ["arachidonic acid", "omega 6 aa", "omega-6 aa", "omega_6_aa", "20:4 n-6", "20:4n6"] },
      { key: "la", label: "LA", unit: "g", aliases: ["linoleic acid", "omega 6 la", "omega-6 la", "omega_6_la", "18:2 n-6", "18:2n6"] },
      { key: "saturated", label: "Saturated", unit: "g", aliases: ["saturated fat"] },
      { key: "trans_fats", label: "Trans-Fats", unit: "g", aliases: ["trans fat", "trans fats"] },
      { key: "cholesterol", label: "Cholesterol", unit: "mg" },
      { key: "phytosterol", label: "Phytosterol", unit: "mg", aliases: ["phytosterols"] },
    ],
  },
  {
    group: "protein_and_amino_acids",
    nutrients: [
      { key: "protein", label: "Protein", unit: "g", aliases: ["protein_g"] },
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
      { key: "vitamin_a", label: "Vitamin A", unit: "mcg", aliases: ["retinol activity equivalent", "rae"] },
      { key: "retinol", label: "Retinol", unit: "mcg" },
      { key: "alpha_carotene", label: "Alpha-Carotene", unit: "mcg" },
      { key: "beta_carotene", label: "Beta-Carotene", unit: "mcg" },
      { key: "beta_cryptoxanthin", label: "Beta-Cryptoxanthin", unit: "mcg" },
      { key: "lycopene", label: "Lycopene", unit: "mcg" },
      { key: "lutein_zeaxanthin", label: "Lutein+Zeaxanthin", unit: "mcg", aliases: ["lutein", "zeaxanthin", "lutein zeaxanthin"] },
      { key: "vitamin_c", label: "Vitamin C", unit: "mg", aliases: ["ascorbic acid"] },
      { key: "vitamin_d", label: "Vitamin D", unit: "IU" },
      { key: "vitamin_e", label: "Vitamin E", unit: "mg", aliases: ["alpha tocopherol", "alpha-tocopherol"] },
      { key: "beta_tocopherol", label: "Beta Tocopherol", unit: "mg" },
      { key: "delta_tocopherol", label: "Delta Tocopherol", unit: "mg" },
      { key: "gamma_tocopherol", label: "Gamma Tocopherol", unit: "mg" },
      { key: "vitamin_k", label: "Vitamin K", unit: "mcg" },
    ],
  },
  {
    group: "minerals",
    nutrients: [
      { key: "calcium", label: "Calcium", unit: "mg" },
      { key: "chromium", label: "Chromium", unit: "mcg" },
      { key: "copper", label: "Copper", unit: "mg" },
      { key: "fluoride", label: "Fluoride", unit: "mcg" },
      { key: "iodine", label: "Iodine", unit: "mcg" },
      { key: "iron", label: "Iron", unit: "mg" },
      { key: "magnesium", label: "Magnesium", unit: "mg" },
      { key: "manganese", label: "Manganese", unit: "mg" },
      { key: "molybdenum", label: "Molybdenum", unit: "mcg" },
      { key: "phosphorus", label: "Phosphorus", unit: "mg" },
      { key: "potassium", label: "Potassium", unit: "mg" },
      { key: "selenium", label: "Selenium", unit: "mcg" },
      { key: "sodium", label: "Sodium", unit: "mg" },
      { key: "zinc", label: "Zinc", unit: "mg" },
    ],
  },
];

const NUTRIENT_LOOKUP = new Map<string, string>();
const NUTRIENT_ORDER = new Map<string, number>();
const NUTRIENT_UNITS = new Map<string, string | undefined>();
const CANONICAL_NUTRIENT_KEYS = new Set<string>();

let nutrientOrder = 0;
for (const group of CUSTOM_FOOD_NUTRIENT_SCHEMA) {
  for (const nutrient of group.nutrients) {
    NUTRIENT_ORDER.set(nutrient.label, nutrientOrder);
    NUTRIENT_UNITS.set(nutrient.label, nutrient.unit);
    nutrientOrder += 1;
    CANONICAL_NUTRIENT_KEYS.add(normalizeNutrientKey(nutrient.key));
    for (const alias of [nutrient.key, nutrient.label, ...(nutrient.aliases ?? [])]) {
      NUTRIENT_LOOKUP.set(normalizeNutrientKey(alias), nutrient.label);
    }
  }
}

export function customFoodNutrientLabelForKey(key: string) {
  const normalized = normalizeNutrientKey(key.trim());
  if (!normalized) return undefined;
  return NUTRIENT_LOOKUP.get(normalized);
}

export function customFoodNutrientMetadataForKey(key: string) {
  const normalized = normalizeNutrientKey(key);
  const label = customFoodNutrientLabelForKey(key);
  return {
    label,
    unit: label === undefined ? undefined : NUTRIENT_UNITS.get(label),
    order: label === undefined ? Number.MAX_SAFE_INTEGER : NUTRIENT_ORDER.get(label) ?? Number.MAX_SAFE_INTEGER,
    aliasPriority: CANONICAL_NUTRIENT_KEYS.has(normalized) ? 0 : 1,
  };
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
