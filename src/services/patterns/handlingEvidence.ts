import { prisma } from "../../lib/prisma.js";
import type { HandlingFeeEvidence } from "./pricingStrategy.js";

/**
 * How good the basket figure an errand is priced on actually is.
 *
 * "What is this basket worth?" has several answers of different quality, and
 * which one was used is part of the answer. The same evidence ladder as
 * categoryRevenueAllocation.buildWeights(), applied to the handling fee:
 *
 *  - **RECEIPT_CONFIRMED** — a receipt was read AND the rider accepted the
 *    figure. The strongest thing this system knows about a basket.
 *  - **RIDER_DECLARED** — a receiptless shop, or a reading the rider has not
 *    confirmed. Real money was spent; nobody has corroborated how much.
 *  - **CUSTOMER_ESTIMATE** — nothing has been bought yet, so the only figure is
 *    the one the customer typed when they listed their items.
 *
 * Recorded on every pricing decision (see pricingStrategy.decideHandlingFee) so
 * a fee can say what it was computed from long after the fact.
 *
 * This does NOT decide what a rider's word is allowed to do to a bill. An
 * unverified figure may lower a fee but never raise one, and it is the quoted
 * ceiling that enforces that, not this ladder — evidence describes the figure,
 * consent decides what may be charged on it.
 *
 * Lives here rather than in proofImageService because that module already
 * imports errandService, and errandService is what needs this — the import would
 * close a cycle. It sits beside categoryFeeModes.resolveCategoryModes, which is
 * the same shape of thing: one pricing fact, resolved from the database, for
 * recalculateFee to gather before it prices anything.
 */
export async function resolveHandlingEvidence(errandId: string): Promise<HandlingFeeEvidence> {
  const purchases = await prisma.errandProofImage.findMany({
    where: { errandId, kind: { in: ["RECEIPT", "NO_RECEIPT"] } },
    select: { kind: true, extraction: { select: { confirmedTotal: true } } },
  });

  if (purchases.length === 0) return "CUSTOMER_ESTIMATE";

  // Only a figure the rider has ACCEPTED counts as read. An extraction sitting
  // unconfirmed is a machine's guess, and confirmProofImage exists precisely
  // because those guesses are wrong often enough to need a person.
  const hasConfirmedReceipt = purchases.some(
    (p) => p.kind === "RECEIPT" && p.extraction?.confirmedTotal != null
  );

  return hasConfirmedReceipt ? "RECEIPT_CONFIRMED" : "RIDER_DECLARED";
}
