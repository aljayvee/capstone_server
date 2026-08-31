function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The fee breakdown as every client renders it.
 *
 * One shape, built server-side, so the customer's checkout, the dispatcher's
 * panel and the rider's job card cannot disagree. Before this existed each
 * surface derived its own — CheckoutScreen computed a total from a hardcoded
 * 2.5 km and omitted two fee components entirely, so the figure a customer
 * accepted could not match what the server later billed.
 *
 * `itemsSubtotal` is kept rigidly outside `fees`. It is the customer's money for
 * the goods, fronted by the company and merely carried by the rider — it is not
 * revenue, it earns no commission, and folding it into a fee is the mistake this
 * separation exists to prevent.
 */
export interface CustomerFeeBreakdown {
  fees: {
    baseFee: number;
    distanceFee: number;
    multiStoreFee: number;
    groceryFee: number;
    nonCodFee: number;
    /** The five above, summed. Equals Errand.deliveryFee. */
    subtotal: number;
  };
  itemsSubtotal: number;
  tip: number;
  grandTotal: number;
  /**
   * False until a dispatcher has pinned stores, because distance — and therefore
   * distanceFee — is genuinely unknown before that. Clients must label this as an
   * estimate rather than presenting a provisional number as settled.
   */
  isFinal: boolean;
  calculatedAt: Date | null;
  /**
   * Stops the dispatcher pinned beyond what the customer originally selected
   * at checkout, and is therefore now paying a multi-store surcharge on (see
   * pricingStoreCount).
   *
   * Zero on an ordinary errand. Above zero it is the reason the Multi-Store
   * Surcharge row is higher than the customer's own checkout selection would
   * predict — without it the fee panel just shows a bigger number with no
   * explanation, and the only person who can tell "correctly charged for a
   * split you made" from "broken" is whoever wrote the pricing code.
   */
  extraChargedStores: number;
}

/** The persisted fields this reads. Structural so it accepts a Prisma errand. */
export interface PricedErrand {
  deliveryFee: number;
  estimatedCost: number;
  tip: number;
  multiStoreFee: number | null;
  groceryFee: number | null;
  nonCodFee: number | null;
  distanceFee: number | null;
  feeCalculatedAt: Date | null;
  routedAt: Date | null;
  /** How many stores the CUSTOMER selected — the floor of what they're charged
   * for; the dispatcher's pins can raise it, see pricingStoreCount. */
  storeCount?: number | null;
  /** How many stops the dispatcher has actually pinned. */
  pinnedStops?: number | null;
}

export function buildFeeBreakdown(errand: PricedErrand): CustomerFeeBreakdown {
  const distanceFee = errand.distanceFee ?? 0;
  const multiStoreFee = errand.multiStoreFee ?? 0;
  const groceryFee = errand.groceryFee ?? 0;
  const nonCodFee = errand.nonCodFee ?? 0;

  // baseFee is derived rather than stored: it is exactly whatever deliveryFee is
  // not accounted for by the four components, so deriving it keeps the parts
  // summing to the whole even for errands priced before those columns existed.
  const baseFee = round2(errand.deliveryFee - (distanceFee + multiStoreFee + groceryFee + nonCodFee));

  return {
    fees: {
      baseFee,
      distanceFee: round2(distanceFee),
      multiStoreFee: round2(multiStoreFee),
      groceryFee: round2(groceryFee),
      nonCodFee: round2(nonCodFee),
      subtotal: round2(errand.deliveryFee),
    },
    itemsSubtotal: round2(errand.estimatedCost),
    tip: round2(errand.tip),
    grandTotal: round2(errand.deliveryFee + errand.estimatedCost + errand.tip),
    // A price is only settled once it was computed against a real routed
    // distance. feeCalculatedAt alone is not enough — an errand can be priced
    // before any store is pinned, on a distance of zero.
    isFinal: errand.feeCalculatedAt !== null && errand.routedAt !== null,
    calculatedAt: errand.feeCalculatedAt,
    extraChargedStores: Math.max(0, (errand.pinnedStops ?? 0) - Math.max(1, errand.storeCount ?? 1)),
  };
}
