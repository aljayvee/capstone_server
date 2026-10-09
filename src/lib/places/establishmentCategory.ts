import { inferStoreCategory } from "../../services/categoryInferenceService.js";
import type { GooglePlace } from "./googlePlacesClient.js";

/**
 * Which merchant category a Google establishment belongs to, so a store the
 * customer picks arrives in the dispatcher's Stage 1 with its category already
 * set, and its items are priced and timed as that kind of shop.
 *
 * Google's own type answers first: "pharmacy" and "supermarket" are reliable
 * and free. Only a place Google files under a generic type ("store") is sent to
 * the category model, the same one the dispatcher's pins use. A place neither
 * can place gets no category, and the dispatcher sets it in Stage 1.
 *
 * Categories are matched by keyword, not by exact name, because owners rename
 * them: production's are Fast Food, Restaurant, Pharmacy, Bread & Pastry,
 * Supermarket & Grocery, Convenience Store and Retail & General Merchandise,
 * while the seed names read "Fast Food & Restaurant", "Pharmacy & Health".
 */

export interface CategoryRef {
  id: number;
  name: string;
}

type Kind = "fastfood" | "restaurant" | "bakery" | "pharmacy" | "grocery" | "convenience" | "retail";

// Google types to a kind of shop, most specific first. Bakery comes before the
// food rules: a bakery also carries "food", and filing Julie's Bakeshop under
// Fast Food is the mistake the web's GOOGLE_TYPE_TO_CATEGORY already made once.
const TYPE_KINDS: Array<{ kind: Kind; types: string[] }> = [
  { kind: "bakery", types: ["bakery"] },
  { kind: "pharmacy", types: ["pharmacy", "drugstore"] },
  { kind: "convenience", types: ["convenience_store", "liquor_store"] },
  { kind: "grocery", types: ["supermarket", "grocery_store", "grocery_or_supermarket", "market"] },
  {
    kind: "fastfood",
    types: ["fast_food_restaurant", "meal_takeaway", "hamburger_restaurant", "pizza_restaurant", "sandwich_shop"],
  },
  { kind: "restaurant", types: ["restaurant", "cafe", "coffee_shop", "meal_delivery", "food_court", "diner"] },
  {
    kind: "retail",
    types: [
      "department_store",
      "hardware_store",
      "clothing_store",
      "electronics_store",
      "home_goods_store",
      "furniture_store",
      "shoe_store",
      "book_store",
      "pet_store",
      "shopping_mall",
    ],
  },
];

// The category name keywords for each kind, in order of preference. A kind with
// no category of its own falls through to its neighbour: a bakery is food where
// there is no Bread & Pastry, a convenience store a grocery.
const KIND_KEYWORDS: Record<Kind, RegExp[]> = {
  fastfood: [/fast\s*food/, /restaurant|food|eatery/],
  restaurant: [/restaurant|dining|eatery/, /food/],
  bakery: [/bake|bread|pastr|cake/, /food|restaurant/],
  pharmacy: [/pharma|drug|health|medic/],
  convenience: [/convenience|sari/, /supermarket|grocer/],
  grocery: [/supermarket|grocer|market/, /convenience/],
  retail: [/retail|merchandise|general|hardware/],
};

function kindOf(type: string): Kind | null {
  const wanted = type.toLowerCase();
  for (const rule of TYPE_KINDS) {
    if (rule.types.includes(wanted)) return rule.kind;
  }
  // Places (New) names cuisines one by one: "chinese_restaurant", "ramen_restaurant".
  if (wanted.endsWith("_restaurant")) return "restaurant";
  return null;
}

/** The active category for a Google place by its types alone, or null. */
export function categoryForGoogleTypes(
  types: string[],
  primaryType: string | null,
  active: CategoryRef[]
): CategoryRef | null {
  const ordered = primaryType ? [primaryType, ...types] : types;
  for (const type of ordered) {
    const kind = kindOf(type);
    if (!kind) continue;
    for (const keyword of KIND_KEYWORDS[kind]) {
      const match = active.find((c) => keyword.test(c.name.toLowerCase()));
      if (match) return match;
    }
  }
  return null;
}

const MODEL_BUDGET_MS = 1500;

/**
 * A category for each place, in order. Types first; the model for the rest,
 * all within one budget so a slow model never holds up the customer's list.
 */
export async function categorizeGooglePlaces(
  places: GooglePlace[],
  active: CategoryRef[],
  budgetMs: number = MODEL_BUDGET_MS
): Promise<Array<CategoryRef | null>> {
  const answers = places.map((p) => categoryForGoogleTypes(p.types, p.primaryType, active));
  const unanswered = places.map((_, i) => i).filter((i) => answers[i] === null);
  if (unanswered.length === 0) return answers;

  const ask = Promise.all(
    unanswered.map(async (i) => {
      const result = await inferStoreCategory(places[i].name, places[i].types).catch(() => null);
      if (result && result.available && "categoryId" in result) {
        answers[i] = { id: result.categoryId, name: result.categoryName };
      }
    })
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  await Promise.race([ask, deadline]);
  clearTimeout(timer);
  // Answers that land after the deadline are dropped on purpose: copy now.
  return [...answers];
}
