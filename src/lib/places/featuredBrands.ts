/**
 * The brands the customer app's "Find stores" list recommends first
 * (2026-10-14): the shops customers in Tacurong order from most, named by the
 * owner. The rest of the list is the usual recommendation order
 * (lib/places/storeRanking.ts: distance, then the customer's own past orders,
 * then everyone's), so it still learns from what each customer buys.
 *
 * Configured, not coded: FEATURED_STORE_BRANDS replaces the default list
 * without a release of the app or the server. Brands are separated by ";",
 * and a brand's other names by "|", the first being the brand's own:
 *
 *   FEATURED_STORE_BRANDS="Jollibee;McDonald's|McDo;7-Eleven|7/11"
 *
 * Matching ignores case and punctuation, and needs the brand's words in order
 * at a word boundary, so "7-Eleven Tacurong New Isabela (3453)" is 7-Eleven
 * and "Kimsan Plaza" is Kimsan, but "Savemore" does not match "Save".
 */

export const DEFAULT_FEATURED_STORE_BRANDS =
  "Jollibee;McDonald's|McDo|McDonalds|Mc Donald's;Fitmart|Fit Mart;Kimsan;Savemore|Save More;7-Eleven|7 Eleven|7/11|711|Seven Eleven";

export interface FeaturedBrand {
  /** The brand's own name, as the list shows it. */
  name: string;
  /** Every name it goes by, simplified for matching. */
  aliases: string[];
}

/** Lower case, "&" as "and", every other mark a space, single spaces. */
function simplify(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The brands in `spec`; the default list when it is empty. */
export function parseFeaturedBrands(spec: string | null | undefined): FeaturedBrand[] {
  const source = spec && spec.trim() ? spec : DEFAULT_FEATURED_STORE_BRANDS;
  return source
    .split(";")
    .map((entry) => entry.split("|").map((part) => part.trim()).filter(Boolean))
    .filter((names) => names.length > 0)
    .map((names) => ({
      name: names[0],
      aliases: [...new Set(names.map(simplify).filter(Boolean))],
    }))
    .filter((brand) => brand.aliases.length > 0);
}

/** The featured brand a store belongs to, by its name, or null. */
export function featuredBrandOf(storeName: string, brands: FeaturedBrand[]): string | null {
  const name = ` ${simplify(storeName)} `;
  if (!name.trim()) return null;
  for (const brand of brands) {
    if (brand.aliases.some((alias) => name.includes(` ${alias} `))) return brand.name;
  }
  return null;
}

/**
 * `ranked` with the best-ranked branch of each featured brand moved to the
 * front, in the order they already ranked (the nearest or most-used first);
 * every other row, other branches included, keeps its place after them.
 * One branch a brand, so six 7-Elevens cannot fill the recommendations.
 */
export function featuredFirst<T>(
  ranked: T[],
  nameOf: (row: T) => string,
  brands: FeaturedBrand[]
): { rows: T[]; featured: Set<T> } {
  const featured = new Set<T>();
  const seenBrands = new Set<string>();
  for (const row of ranked) {
    const brand = featuredBrandOf(nameOf(row), brands);
    if (brand && !seenBrands.has(brand)) {
      seenBrands.add(brand);
      featured.add(row);
    }
  }
  return {
    rows: [...ranked.filter((row) => featured.has(row)), ...ranked.filter((row) => !featured.has(row))],
    featured,
  };
}
