export interface PricingStoreCountInput {
  /** What the customer committed to at checkout — their category count. */
  storeCount: number;
  /**
   * How many DISTINCT stops the dispatcher has actually pinned.
   *
   * Distinct, not `pinpoints.length`. Use {@link distinctStopCount} to derive
   * it — passing the raw array length bills the customer again for a shop that
   * was merely pinned twice.
   */
  pinnedStops: number;
}

/**
 * How many stores the customer is charged for.
 *
 * The larger of what the customer selected at checkout and how many stores the
 * dispatcher has actually pinned. The customer's own selection is a FLOOR, never
 * a ceiling: consolidating three chosen categories into one shop does not refund
 * the multi-store fee they already agreed to, and pinning MORE stores than they
 * selected now raises it — fulfilling one category across two shops is two
 * stops' worth of real rider time and route complexity, and that cost is billed
 * rather than absorbed by the company.
 *
 * This reverses the previous rule (`pinnedStops` was accepted but deliberately
 * ignored) at Sugo Express's explicit direction, after being shown the
 * trade-off it re-accepts and choosing it anyway. Know the trade-off before
 * touching this function again: a customer can end up billed for a split they
 * did not choose at checkout and cannot see coming until the dispatcher pins
 * it — burgers and noodles filed under one Fast Food category, the dispatcher
 * notices the noodles belong at a grocery, pins a second stop, and the
 * customer's fare rises for a decision they did not make. That is accepted
 * here, deliberately, not overlooked. If it turns out to be a real trust
 * problem in practice, the fix is to disclose the added stop to the customer
 * BEFORE the extra charge lands, not to silently revert this function.
 */
export function pricingStoreCount(input: PricingStoreCountInput): number {
  const selected = Math.max(1, Math.round(input.storeCount) || 1);
  const pinned = Math.max(1, Math.round(input.pinnedStops) || 1);
  return Math.max(selected, pinned);
}


/**
 * How many separate SHOPS a list of pinpoints represents.
 *
 * Nothing prevented a shop being pinned twice, and the multi-store fee was
 * computed from `pinpoints.length`, so a duplicate silently added another
 * `multiStoreFeePerStore` to a fare the customer had already agreed to — and
 * `feeBreakdown.extraChargedStores` then presented that surcharge to them as
 * legitimate. Two rows for one shop is not two stops of rider time, which is
 * the thing the fee exists to bill for.
 *
 * Two pins collapse into one stop when they name the same catalogue place, or
 * when they sit on the same coordinate to five decimal places (~1.1 m).
 *
 * The coordinate tolerance is deliberately that tight. It is not trying to
 * catch "the dispatcher clicked the same shop twice, a few metres apart" — the
 * dispatcher screen warns about that case at 40 m and lets them override it on
 * purpose, because two real shops can share a building. Widening it here would
 * silently stop billing for a genuine two-shop split, which is exactly the
 * revenue the rule above is meant to capture. So this collapses only what is
 * provably one place, and leaves the judgement call to the human who can see
 * the map.
 */
export function distinctStopCount(
  pinpoints: Array<{
    placeId?: string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
  }> | null | undefined
): number {
  interface Group {
    placeIds: Set<string>;
    coords: Set<string>;
  }
  const groups: Group[] = [];

  for (const pin of pinpoints || []) {
    const placeId = typeof pin?.placeId === "string" ? pin.placeId.trim() : "";
    const lat = Number(pin?.latitude);
    const lng = Number(pin?.longitude);
    const coordKey =
      Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(5)},${lng.toFixed(5)}` : "";

    // Nothing identifiable at all - count it, rather than quietly discounting.
    if (!placeId && !coordKey) {
      groups.push({ placeIds: new Set(), coords: new Set() });
      continue;
    }

    // A pin can match an existing stop by EITHER signal, which is what lets a
    // catalogue pin and a bare map click on the same coordinate collapse together.
    const existing = groups.find(
      (g) => (placeId && g.placeIds.has(placeId)) || (coordKey && g.coords.has(coordKey))
    );
    const group = existing ?? { placeIds: new Set<string>(), coords: new Set<string>() };
    if (placeId) group.placeIds.add(placeId);
    if (coordKey) group.coords.add(coordKey);
    if (!existing) groups.push(group);
  }

  return groups.length;
}
