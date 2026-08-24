import { splitCommission } from "./commissionSplit.js";

/**
 * What one errand pays its rider, in the shape the rider app renders.
 *
 * This exists because the rider app was showing them the wrong number. Its
 * mapper set `serviceFee` from `deliveryFee`, and five components rendered that
 * as earnings — one of them under the label "GUARANTEED EARNINGS". On a ₱147
 * delivery fee the rider was promised ₱147 and actually received ₱102.90, a
 * figure 43% too high on which they decided whether to take the job.
 *
 * Every field the rider needs to check the arithmetic is included, not just the
 * result. A rider who can see the split is far less likely to dispute it, and
 * `itemCostExcluded` is here specifically so the money they carry for the goods
 * is named as the company's rather than left to look like part of the total.
 */
export interface RiderEarnings {
  /** The headline figure: (deliveryFee × rate) + the whole tip. */
  riderShare: number;
  businessShare: number;
  /** The gross fee the split was taken from. */
  deliveryFee: number;
  tip: number;
  commissionRate: number;
  /** Company money the rider carries for the purchase. Earns nobody anything. */
  itemCostExcluded: number;
  /**
   * True when this came from a stored RiderCommission row — the recorded payout
   * rather than a projection. False before the errand is delivered, when the fee
   * can still move (a receipt total reprices the errand).
   */
  isFinal: boolean;
}

/** The persisted fields this reads. Structural, so it accepts a Prisma errand. */
export interface EarningErrand {
  deliveryFee: number;
  tip: number;
  estimatedCost: number;
  commission?: {
    riderShare: number;
    businessShare: number;
    deliveryFee: number;
    tip: number;
    commissionRate: number;
    itemCostExcluded: number;
  } | null;
}

export function buildRiderEarnings(errand: EarningErrand): RiderEarnings {
  // Prefer the recorded payout where one exists — same preference the settlement
  // report applies, and for the same reason: a figure already settled must not be
  // restated by a later read.
  if (errand.commission) {
    return { ...errand.commission, isFinal: true };
  }

  const split = splitCommission({
    deliveryFee: errand.deliveryFee,
    tip: errand.tip,
    itemCost: errand.estimatedCost,
  });

  return {
    riderShare: split.riderShare,
    businessShare: split.businessShare,
    deliveryFee: round2(errand.deliveryFee),
    tip: round2(errand.tip),
    commissionRate: split.commissionRate,
    itemCostExcluded: split.itemCostExcluded,
    isFinal: false,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
