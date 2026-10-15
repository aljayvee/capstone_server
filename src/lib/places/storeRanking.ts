/**
 * How the customer app's "Location" list orders stores (2026-10-08).
 *
 * Built the way YouTube and TikTok recommend videos, in two stages:
 *
 *   1. Candidate generation. Google Places and the owner's Location Stores each
 *      return up to 20 shops (services/establishmentService.ts). Many more than
 *      are shown, so the ranking below has real choices to make: a search for a
 *      chain finds every branch, not just whichever ten Google listed first.
 *   2. Ranking. Every candidate gets a score from four signals, and the list is
 *      sorted by it. Distance carries the most weight, so the closest store wins
 *      unless the customer, or everyone, has a clear habit of using another.
 *
 * For a typed search, relevance is a gate before the score, not part of it: the
 * stores whose NAME matches what was typed come before those Google matched on
 * an address or a kind of shop. Otherwise a corner store 100 m away would beat
 * the Mercury Drug the customer typed, purely on distance.
 *
 * Every function here is pure, so the weights can be tuned and tested without
 * a database or Google.
 */

/** How much each signal counts. They add up to 1; distance is the heaviest. */
export const RANKING_WEIGHTS = {
  proximity: 0.5,
  personal: 0.25,
  popularity: 0.15,
  nameMatch: 0.1,
} as const;

/** exp(-d / 1000): 0.5 at about 700 m, 0.25 at 1.4 km. Tacurong is small. */
export const PROXIMITY_SCALE_METERS = 1000;

/** The customer's own orders: a store used two months ago counts half. */
export const PERSONAL_HALF_LIFE_DAYS = 60;
/** Everyone's orders: popularity is about now, so it fades faster. */
export const POPULARITY_HALF_LIFE_DAYS = 30;

/** Weighted orders that make a habit: 2 recent orders are already strong. */
const PERSONAL_SATURATION = 2;
/** For everyone together, 5 recent orders. */
const POPULARITY_SATURATION = 5;

/** A name match this strong qualifies a store for the top group of a search. */
export const NAME_MATCH_GATE = 0.6;

/** 1 at the customer's door, falling toward 0 with distance. 0 when unknown. */
export function proximityScore(distanceMeters: number | null): number {
  if (distanceMeters === null || !Number.isFinite(distanceMeters) || distanceMeters < 0) return 0;
  return Math.exp(-distanceMeters / PROXIMITY_SCALE_METERS);
}

/** How much an order this many days old still counts: 1 today, 0.5 at one half-life. */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

/** Recency-weighted orders, squeezed into 0..1 so no habit can outweigh everything. */
export function affinityScore(weightedOrders: number, saturation: number): number {
  if (!(weightedOrders > 0)) return 0;
  return 1 - Math.exp(-weightedOrders / saturation);
}

const simplify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * How well a store's name answers what the customer typed, 0..1.
 * 1 exact, 0.9 starts with it, 0.75 every word typed starts a word of the name,
 * 0.6 contained, partial word hits below that, and 0.1 when only Google knew why
 * (it matched an address or a kind of shop).
 */
export function nameMatchScore(name: string, query: string): number {
  const q = simplify(query);
  if (!q) return 0;
  const n = simplify(name);
  if (n === q) return 1;
  if (n.startsWith(q)) return 0.9;
  const nameWords = n.split(" ");
  const queryWords = q.split(" ");
  const hits = queryWords.filter((word) => nameWords.some((w) => w.startsWith(word))).length;
  if (hits === queryWords.length) return 0.75;
  if (n.includes(q)) return 0.6;
  if (hits > 0) return (0.4 * hits) / queryWords.length;
  return 0.1;
}

/** What is known about one candidate store, before it is scored. */
export interface RankingInput {
  distanceMeters: number | null;
  /** This customer's orders from the store, each weighted by recency. */
  personalOrders: number;
  /** Every customer's recent orders from the store, each weighted by recency. */
  popularOrders: number;
  /** nameMatchScore against the search, or 0 for the list shown before typing. */
  nameMatch: number;
  /** True when the store has verified off-road physical coordinates from verified_places. */
  isVerified?: boolean;
}

export function recommendationScore(input: RankingInput): number {
  const base =
    RANKING_WEIGHTS.proximity * proximityScore(input.distanceMeters) +
    RANKING_WEIGHTS.personal * affinityScore(input.personalOrders, PERSONAL_SATURATION) +
    RANKING_WEIGHTS.popularity * affinityScore(input.popularOrders, POPULARITY_SATURATION) +
    RANKING_WEIGHTS.nameMatch * input.nameMatch;

  // Verified catalogue stores with curated off-road coordinates get a +0.15 confidence boost
  return input.isVerified ? base + 0.15 : base;
}

/**
 * Best first. A typed search puts name matches (NAME_MATCH_GATE and up) ahead
 * of everything else, then orders each group by score. Ties keep the order the
 * rows came in, which is the sources' own (Google's distance or relevance).
 */
export function rankByRecommendation<T>(rows: T[], inputOf: (row: T) => RankingInput, searching: boolean): T[] {
  return rows
    .map((row, index) => {
      const input = inputOf(row);
      return {
        row,
        index,
        gate: searching && input.nameMatch >= NAME_MATCH_GATE ? 1 : 0,
        score: recommendationScore(input),
      };
    })
    .sort((a, b) => b.gate - a.gate || b.score - a.score || a.index - b.index)
    .map(({ row }) => row);
}

/**
 * Ratings a store needs before its stars can lead the popular list. One 5-star
 * review is not a reputation: without this, a shop rated once outranks one
 * rated 4.8 by three hundred people.
 */
export const MIN_RATINGS_TO_LEAD = 5;

/**
 * The Home tab's "Popular Stores": Google's rating first, as asked for.
 *
 * Stores with at least MIN_RATINGS_TO_LEAD ratings come first, highest rating
 * first; then the rest the same way; then stores nobody has rated. Ties go to
 * the store more people rated, then to the order Google gave (its popularity).
 */
export function rankByRating<T extends { rating: number | null; ratingCount: number | null }>(rows: T[]): T[] {
  const tier = (row: T) =>
    row.rating === null ? 0 : (row.ratingCount ?? 0) >= MIN_RATINGS_TO_LEAD ? 2 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        tier(b.row) - tier(a.row) ||
        (b.row.rating ?? 0) - (a.row.rating ?? 0) ||
        (b.row.ratingCount ?? 0) - (a.row.ratingCount ?? 0) ||
        a.index - b.index
    )
    .map(({ row }) => row);
}

/**
 * The best-rated row of each group (a merchant category), then those winners
 * best-rated first, at most `limit`. A row nobody has rated never wins its
 * group: "best rated" has to mean rated. Rows with no group are left out.
 */
export function bestRatedPerGroup<T extends { rating: number | null; ratingCount: number | null }>(
  rows: T[],
  groupOf: (row: T) => string | number | null,
  limit: number
): T[] {
  const winners = new Map<string | number, T>();
  // rankByRating keeps its order stable, so the first row seen of a group is its best.
  for (const row of rankByRating(rows)) {
    if (row.rating === null) continue;
    const group = groupOf(row);
    if (group === null || winners.has(group)) continue;
    winners.set(group, row);
  }
  return rankByRating([...winners.values()]).slice(0, limit);
}

/** The Popular Stores screen's sort settings (2026-10-10). */
export const POPULAR_SORTS = ["recommended", "rating", "distance", "reviews"] as const;
export type PopularSort = (typeof POPULAR_SORTS)[number];

/**
 * The popular stores in the order the customer chose. The set never changes
 * with the sort, only its order, so paging through one sort shows the same
 * stores as another.
 *   recommended: as given (the best of each category first, the rest best rated);
 *   rating: best rated first (rankByRating);
 *   distance: nearest first, unknown distances last;
 *   reviews: most ratings first, then the higher rating.
 * Ties keep the order given.
 */
export function orderPopular<
  T extends { rating: number | null; ratingCount: number | null; distanceMeters: number | null },
>(rows: T[], sort: PopularSort): T[] {
  if (sort === "rating") return rankByRating(rows);
  if (sort === "recommended") return [...rows];
  const far = (row: T) => (row.distanceMeters === null ? Number.POSITIVE_INFINITY : row.distanceMeters);
  const compare =
    sort === "distance"
      ? (a: T, b: T) => (far(a) === far(b) ? 0 : far(a) < far(b) ? -1 : 1)
      : (a: T, b: T) => (b.ratingCount ?? 0) - (a.ratingCount ?? 0) || (b.rating ?? 0) - (a.rating ?? 0);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compare(a.row, b.row) || a.index - b.index)
    .map(({ row }) => row);
}
