import { DIVERGENCE_ABSOLUTE, DIVERGENCE_FRACTION } from "../proofImageService.js";

/**
 * What counts as an errand that did not reconcile, and which of those are worth
 * putting in front of a person.
 *
 * Pure: no database, no dates resolved here. The service derives rows and asks
 * these rules whether each one matters, so the rule is testable on its own and
 * the dispatcher's queue and the owner's report cannot disagree about what an
 * exception is.
 */

export type ExceptionKind =
  /** Cash back differed from the errand's total. */
  | "CASH_VARIANCE"
  /** The rider's confirmed figure is far from what the machine read. */
  | "RECEIPT_DIVERGENCE"
  /** A purchase from a shop that issued no receipt — the rider's word. */
  | "UNVERIFIED_PURCHASE"
  /** The rider settled at a different branch than the one pinned. */
  | "WRONG_BRANCH"
  /** A stop with items and no proof of any kind behind it. */
  | "MISSING_RECEIPT"
  /** Dwell far past what this kind of shop usually takes. */
  | "STALLED_STOP";

/**
 * Below this, a money exception is noise.
 *
 * A one-peso rounding variance sitting in the same list as a two-thousand-peso
 * shortfall is what makes a review queue unreadable, and a queue nobody
 * finishes is not a control. Conduct exceptions ignore this entirely — see
 * isMaterial.
 *
 * Set against THIS business rather than a round number. The delivery fee is
 * about ₱70 and a typical errand totals under ₱300, so a ₱43 shortfall is a
 * sixth of the bill and plainly worth someone's attention — an earlier ₱50
 * threshold silently swallowed exactly that case. The fare is charged in whole
 * pesos, so genuine arithmetic drift is never more than a centavo or two; ₱20
 * sits above anything that could be an artifact and below anything a person
 * running this business would wave through.
 */
export const MATERIALITY_PESOS = 20;

/**
 * Kinds that are about money, and therefore subject to the threshold above.
 *
 * The rest are about conduct. A rider visiting the wrong branch of a chain or
 * buying somewhere that prints no receipt is worth seeing whatever it cost —
 * the amount is not what makes it interesting, and a cheap one is exactly as
 * informative about a pattern as an expensive one.
 */
const MONEY_KINDS: ReadonlySet<ExceptionKind> = new Set<ExceptionKind>([
  "CASH_VARIANCE",
  "RECEIPT_DIVERGENCE",
]);

export function isMoneyException(kind: ExceptionKind): boolean {
  return MONEY_KINDS.has(kind);
}

export interface ErrandException {
  errandId: string;
  kind: ExceptionKind;
  /** Always non-negative. Zero for conduct kinds, which risk no money. */
  amountAtRisk: number;
  /** One line a person can act on, naming the figures involved. */
  detail: string;
  riderId: number | null;
  riderName: string | null;
  occurredAt: Date;
  /** Set once someone has cleared it — see ExceptionReview. */
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionReason: string | null;
}

/** Whether this occurrence is worth surfacing at all. */
export function isMaterial(kind: ExceptionKind, amountAtRisk: number): boolean {
  if (!isMoneyException(kind)) return true;
  return Math.abs(amountAtRisk) >= MATERIALITY_PESOS;
}

/**
 * How far a rider's confirmed total may drift from the machine's reading before
 * it is an exception.
 *
 * The same ₱100-or-20% rule confirmProofImage already alerts dispatch on, imported
 * rather than restated — a queue that disagreed with the live alert would be
 * worse than having neither.
 */
export function receiptDivergenceThreshold(extractedTotal: number): number {
  return Math.max(DIVERGENCE_ABSOLUTE, Math.abs(extractedTotal) * DIVERGENCE_FRACTION);
}

export function isReceiptDivergent(extractedTotal: number, confirmedTotal: number): boolean {
  return Math.abs(confirmedTotal - extractedTotal) > receiptDivergenceThreshold(extractedTotal);
}

/**
 * Most at risk first, so a queue read top-down is read in the right order.
 *
 * Conduct exceptions carry no amount and would otherwise sink to the bottom
 * forever, so ties break toward the older one: something flagged three weeks ago
 * and never cleared is the thing this list exists to stop being invisible.
 */
export function rankExceptions(exceptions: ErrandException[]): ErrandException[] {
  return [...exceptions].sort((a, b) => {
    if (b.amountAtRisk !== a.amountAtRisk) return b.amountAtRisk - a.amountAtRisk;
    return a.occurredAt.getTime() - b.occurredAt.getTime();
  });
}

/**
 * A rider's exposure as a RATE, not a count.
 *
 * A rider who runs three times the errands should not look three times worse,
 * which counting alone guarantees. Zero errands yields zero rather than a
 * division by zero — a rider with no completed work has no pattern yet, and
 * inventing one from an empty denominator is the fastest way to accuse someone
 * of nothing.
 */
export function exceptionRate(exceptionCount: number, errandCount: number): number {
  if (errandCount <= 0) return 0;
  return Math.round((exceptionCount / errandCount) * 1000) / 1000;
}
