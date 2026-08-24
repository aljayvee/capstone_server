export interface PricingStoreCountInput {
  /** What the customer committed to at checkout — their category count. */
  storeCount: number;
  /** How many stops the dispatcher has actually pinned. */
  pinnedStops: number;
}

/**
 * How many stores the customer is charged for.
 *
 * This used to be `Math.max(errand.storeCount, pinpoints.length, 1)`, so pinning
 * stores raised the fare. That produced the reported bug: a customer orders
 * burgers and noodles under one category, the dispatcher notices the noodles are
 * not fast food and pins a grocery as a second stop, and the customer is billed
 * a multi-store fee for a split they never asked for and cannot see the reason
 * for — on an order whose fees then exceed the goods.
 *
 * The dispatcher's pins still drive the ROUTE, and therefore the distance fee:
 * that reflects real kilometres a rider covers. What they no longer drive is the
 * multi-store fee, which is a charge for a decision only the customer can make.
 *
 * `pinnedStops` is accepted but deliberately unused, so the rule reads as the
 * decision it is rather than looking like the parameter was forgotten.
 */
export function pricingStoreCount(input: PricingStoreCountInput): number {
  void input.pinnedStops;
  return Math.max(1, Math.round(input.storeCount) || 1);
}
