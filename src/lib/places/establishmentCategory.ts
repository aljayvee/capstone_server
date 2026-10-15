import { inferStoreCategory } from "../../services/categoryInferenceService.js";
import { SEARCHABLE_TYPES, type GooglePlace } from "./googlePlacesClient.js";

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
 * The owner's categories decide first (2026-10-10). A category named after a
 * kind of shop ("Cafe", "Pet Supplies", "Hardware") claims Google's types for
 * it, and one whose description names it ("coffee, tea") claims it next, read
 * from the live categories on every request. So a category added or renamed in
 * the owner portal sorts Google's shops the moment it is saved, as the category
 * model and its AI second opinion already adapt on their own (they retrain on
 * every category edit). Until then a code change was needed: production's new
 * "Cafe" got no cafes, because this file only knew the built-in names.
 *
 * The built-in kinds below are the fallback for a type no category names, and
 * they too match by keyword, because owners rename categories: production's
 * are Fast Food, Restaurant, Pharmacy, Bakery, Supermarket & Grocery,
 * Convenience Store, Retail & General Merchandise and Cafe, while the seed
 * names read "Fast Food & Restaurant", "Pharmacy & Health".
 */

export interface CategoryRef {
  id: number;
  name: string;
  /** The owner's description: a category claims the kinds of shop it names. */
  description?: string | null;
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

// Google's types that say nothing about what a shop sells: never claimed.
const GENERIC_TYPES = new Set(["store", "food", "establishment", "point_of_interest", "premise", "service", "health"]);
// Dropped from a type's own words, unless nothing else is left: "pet_store" is
// "pet", "chinese_restaurant" is "chinese", "fast_food_restaurant" is "fast",
// "restaurant" stays "restaurant". "food" alone would hand every food court and
// food store to whichever category has "Food" in its name.
const TYPE_SUFFIX_WORDS = new Set(["store", "shop", "restaurant", "food"]);
/**
 * Other words a Google type goes by. Google's vocabulary, which does not change
 * with the owner's categories, so it is fine to list here: "Cafe" claims coffee
 * shops, "Bread & Pastry" bakeries, "Drugstore" pharmacies.
 */
const TYPE_ALIASES: Record<string, string[][]> = {
  cafe: [["coffee"]],
  coffee_shop: [["cafe"]],
  bakery: [["bakeshop"], ["bread"], ["pastry"], ["panaderia"]],
  pharmacy: [["drugstore"], ["drug"], ["botika"]],
  drugstore: [["pharmacy"], ["drug"], ["botika"]],
  supermarket: [["grocery"]],
  grocery_store: [["supermarket"]],
  convenience_store: [["sari", "sari"], ["minimart"]],
  tea_house: [["tea"]],
  hamburger_restaurant: [["burger"]],
  meal_takeaway: [["takeout"]],
};

/** A word's singular, so "Drugstores" names "drugstore" and "Groceries" "grocery". */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function wordsOf(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(singular)
  );
}

/** The word sets a shop type is known by: its own words, then its aliases. None for a type that names no kind of shop. */
function namesOfType(type: string): string[][] {
  const wanted = type.toLowerCase();
  if (GENERIC_TYPES.has(wanted)) return [];
  const isShop =
    kindOf(wanted) !== null || SEARCHABLE_TYPES.includes(wanted) || /_(store|shop|restaurant)$/.test(wanted) || wanted in TYPE_ALIASES;
  if (!isShop) return [];
  const all = wanted.split("_").filter(Boolean).map(singular);
  const own = all.filter((w) => !TYPE_SUFFIX_WORDS.has(w));
  return [own.length > 0 ? own : all, ...(TYPE_ALIASES[wanted] ?? [])];
}

interface CategoryWords {
  category: CategoryRef;
  name: Set<string>;
  description: Set<string>;
}

// Per list of live categories (one per request), so a long list of places
// costs one reading of the categories and one look per type.
const wordsByCategories = new WeakMap<CategoryRef[], CategoryWords[]>();
const claimsByCategories = new WeakMap<CategoryRef[], Map<string, CategoryRef | null>>();

/**
 * The category that claims a shop type: the one whose NAME holds all of one of
 * the type's word sets, else the one whose DESCRIPTION does. Two claiming at
 * the same level go to the one with the shorter name ("Grocery" over
 * "Supermarket & Grocery"); a true tie claims nothing, and the kinds decide.
 */
function claimFor(type: string, active: CategoryRef[]): CategoryRef | null {
  let claims = claimsByCategories.get(active);
  if (!claims) {
    claims = new Map();
    claimsByCategories.set(active, claims);
  }
  const known = claims.get(type);
  if (known !== undefined) return known;

  let words = wordsByCategories.get(active);
  if (!words) {
    words = active.map((category) => ({
      category,
      name: wordsOf(category.name),
      description: wordsOf(category.description),
    }));
    wordsByCategories.set(active, words);
  }

  const names = namesOfType(type);
  let claimed: CategoryRef | null = null;
  for (const level of ["name", "description"] as const) {
    if (names.length === 0) break;
    const claimants = words
      .filter((c) => names.some((set) => set.every((w) => c[level].has(w))))
      .sort((a, b) => a.name.size - b.name.size);
    if (claimants.length === 1 || (claimants.length > 1 && claimants[0].name.size < claimants[1].name.size)) {
      claimed = claimants[0].category;
      break;
    }
  }
  claims.set(type, claimed);
  return claimed;
}

/**
 * The active category for a Google place by its types alone, or null. Its
 * types are read most specific first (Google's primary type, then the rest);
 * the first one a category claims, or failing that a built-in kind places,
 * decides.
 */
export function categoryForGoogleTypes(
  types: string[],
  primaryType: string | null,
  active: CategoryRef[]
): CategoryRef | null {
  const ordered = primaryType ? [primaryType, ...types] : types;
  for (const type of ordered) {
    const claimed = claimFor(type, active);
    if (claimed) return claimed;
    const kind = kindOf(type);
    if (!kind) continue;
    for (const keyword of KIND_KEYWORDS[kind]) {
      const matches = active
        .filter((c) => keyword.test(c.name.toLowerCase()))
        .sort((a, b) => wordsOf(a.name).size - wordsOf(b.name).size);
      if (matches.length > 0) return matches[0];
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
