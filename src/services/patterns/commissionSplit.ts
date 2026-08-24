// Fixed rider/business split for commission & settlement (Dashboard revenue
// overview, Commission Report, Settlement Report). A business rule, not an
// owner-configurable rate, so the ratio lives in exactly one place instead of
// being duplicated as a magic number per report.
export const RIDER_SHARE_RATE = 0.7;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface CommissionInput {
  /** The service fee the company charged. The ONLY thing the split applies to. */
  deliveryFee: number;
  /** Gratuity. Passes to the rider whole — see below. */
  tip: number;
  /**
   * What the goods cost. Recorded so the exclusion is evidenced, never split.
   */
  itemCost: number;
}

export interface CommissionSplit {
  /** deliveryFee × rate, plus the entire tip. */
  riderShare: number;
  /** The remainder of deliveryFee. Never includes tip or item money. */
  businessShare: number;
  /** Echoed back so a stored snapshot can prove what was left out. */
  itemCostExcluded: number;
  commissionRate: number;
}

/**
 * Splits ONE errand's earnings between rider and business.
 *
 * Two rules this enforces, both of which the previous implementation broke by
 * accepting a single `totalCost` number:
 *
 * 1. **Item money is not revenue.** The company fronts the cash for the goods and
 *    the rider merely carries it to the store. It was previously included in the
 *    figure passed here, so riders were being credited 70% of the company's own
 *    purchase money — on a ₱3,000 grocery run, ₱2,100 of commission that no one
 *    had earned.
 *
 * 2. **A tip is not the company's to share.** It is given to the rider
 *    personally, so it passes through whole rather than being split.
 *
 * Taking a structured input rather than a bare number is deliberate: the old
 * signature made passing the wrong total both easy and invisible, and every one
 * of its three call sites did exactly that.
 */
export function splitCommission(input: CommissionInput): CommissionSplit {
  const riderFeeShare = round2(input.deliveryFee * RIDER_SHARE_RATE);

  return {
    riderShare: round2(riderFeeShare + input.tip),
    // Derived as the remainder rather than deliveryFee × 0.3 independently, so
    // the two fee halves always reconstitute deliveryFee exactly after rounding.
    businessShare: round2(input.deliveryFee - riderFeeShare),
    itemCostExcluded: round2(input.itemCost),
    commissionRate: RIDER_SHARE_RATE,
  };
}
