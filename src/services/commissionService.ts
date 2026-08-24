import { commissionRepository } from "../repositories/commissionRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { logger } from "../lib/logger.js";
import { splitCommission } from "./patterns/commissionSplit.js";

/**
 * Records what one errand earned its rider, at the moment the errand finished.
 *
 * A snapshot rather than a live calculation for two reasons. It makes a past
 * payout stable — a report run next month reproduces the same figure even if the
 * rate or the fee schedule has moved since. And it makes the payout explainable:
 * the row keeps the inputs beside the result, so a rider asking "why this
 * amount?" gets an answer from stored data rather than a recomputation that may
 * no longer agree.
 *
 * Silent no-op when there is no rider — an errand cancelled before assignment has
 * no one to pay.
 */
export async function recordCommission(errandId: string) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) return null;
  if (errand.riderId === null) return null;

  const split = splitCommission({
    deliveryFee: errand.deliveryFee,
    tip: errand.tip,
    // Passed only so the snapshot can evidence what was held out of the split.
    // splitCommission never divides it.
    itemCost: errand.estimatedCost,
  });

  const recorded = await commissionRepository.record({
    errandId,
    riderId: errand.riderId,
    deliveryFee: errand.deliveryFee,
    tip: errand.tip,
    commissionRate: split.commissionRate,
    riderShare: split.riderShare,
    businessShare: split.businessShare,
    itemCostExcluded: split.itemCostExcluded,
  });

  logger.info(
    `Errand ${errandId}: rider ${errand.riderId} earns ${split.riderShare} ` +
      `(${errand.deliveryFee} fee x ${split.commissionRate} + ${errand.tip} tip); ` +
      `business ${split.businessShare}; ${split.itemCostExcluded} item cost excluded.`
  );

  return recorded;
}

export function getRiderEarnings(riderId: number, limit?: number) {
  return commissionRepository.listForRider(riderId, limit);
}

export function getRiderEarningsTotals(riderId: number, start: Date, end: Date) {
  return commissionRepository.totalsForRider(riderId, start, end);
}
