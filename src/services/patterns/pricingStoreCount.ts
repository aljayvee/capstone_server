export interface PricingStoreCountInput {
  /** What the customer committed to at checkout — their category count. */
  storeCount: number;
  /** How many stops the dispatcher has actually pinned. */
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
