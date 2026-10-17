export type RecipeUnitMode = "written" | "us" | "metric";
// NIST SP 811, Appendix B.8. View-only conversion; no ingredient-density guesses.
// https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b8
export const RECIPE_MEASURES = Object.freeze({ millilitersPerUsCup: 236.5882365, gramsPerOunce: 28.349523125, ouncesPerPound: 16 });
const metric: Readonly<Record<string, readonly ["volume" | "mass", number]>> = {
  ml: ["volume", 1], milliliter: ["volume", 1], milliliters: ["volume", 1], l: ["volume", 1000], liter: ["volume", 1000], liters: ["volume", 1000],
  g: ["mass", 1], gram: ["mass", 1], grams: ["mass", 1], kg: ["mass", 1000], kilogram: ["mass", 1000], kilograms: ["mass", 1000]
};
const customary: Readonly<Record<string, readonly ["volume" | "mass", number]>> = {
  cup: ["volume", RECIPE_MEASURES.millilitersPerUsCup], cups: ["volume", RECIPE_MEASURES.millilitersPerUsCup],
  oz: ["mass", RECIPE_MEASURES.gramsPerOunce], ounce: ["mass", RECIPE_MEASURES.gramsPerOunce], ounces: ["mass", RECIPE_MEASURES.gramsPerOunce],
  lb: ["mass", RECIPE_MEASURES.gramsPerOunce * RECIPE_MEASURES.ouncesPerPound], lbs: ["mass", RECIPE_MEASURES.gramsPerOunce * RECIPE_MEASURES.ouncesPerPound]
};

export function recipeQuantity(amount: number, unit: string, mode: RecipeUnitMode): Readonly<{ amount: number; unit: string; converted: boolean }> {
  const key = unit.trim().toLowerCase(), source = mode === "us" ? metric[key] : mode === "metric" ? customary[key] : undefined;
  // Culinary spoons stay as written in both native views. Unknown/count units
  // likewise remain literal; volume never turns into mass without evidence.
  if (!source) return { amount, unit, converted: false };
  const [kind, scale] = source, quantity = amount * scale;
  return mode === "us"
    ? { amount: quantity / (kind === "volume" ? RECIPE_MEASURES.millilitersPerUsCup : RECIPE_MEASURES.gramsPerOunce), unit: kind === "volume" ? "cup" : "oz", converted: true }
    : { amount: quantity, unit: kind === "volume" ? "ml" : "g", converted: true };
}
