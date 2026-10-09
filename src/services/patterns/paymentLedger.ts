export type ErrandPaymentKindValue = "UPFRONT" | "TOP_UP" | "FINAL" | "REFUND";

/** One ledger row, reduced to what the arithmetic needs. */
export interface LedgerEntry {
  kind: ErrandPaymentKindValue;
  amount: number;
}

/**
 * The 50% downpayment was retired on 2026-10-08, on the owner's instruction.
 *
 * GCash / PayMaya and Bank Transfer now run the way cash on delivery does: the
 * rider buys everything with the company's money and the customer pays the
 * whole bill at the door, by transfer (the rider photographs the confirmation
 * and the system records it, errandPaymentService.confirmBalanceFromRiderProof)
 * or in cash. Nothing is owed before the door, and nothing waits on a dispatcher.
 *
 * Old errands keep the UPFRONT rows they already have: they still count as money
 * paid, so a half collected before the change is never asked for twice.
 */

/**
 * How far a receipt may exceed what the customer agreed to before the errand
 * stops and the office gets involved.
 *
 * Set to the exception report's own materiality floor rather than a new number,
 * so "worth a person's attention" means one thing across the system. Below it,
 * the company absorbs a few pesos of drift rather than holding a rider at a door
 * over small change.
 *
 * Deliberately NOT proofImageService's DIVERGENCE_ABSOLUTE/FRACTION: those
 * compare a machine's reading against the rider's own confirmation, which is a
 * question about legibility, not about money the customer has not agreed to.
 */
export const OVERAGE_ESCALATION_PESOS = 20;

/**
 * Four states, each one a different thing somebody has to do next:
 *
 *  - `AWAITING_BALANCE`  — money is owed and the rider collects it at the door.
 *  - `SETTLED`           — nothing owed.
 *  - `REFUNDED`          — cancelled after money came in; it goes back.
 *  - `CANCELLED`         — cancelled before any money came in; nothing to return.
 *
 * `CANCELLED` was split out of `REFUNDED` on 2026-10-09. Since pay-at-the-door,
 * most cancelled GCash / PayMaya / Bank errands never took a peso, and the
 * customer app was telling them their payment "is being returned".
 *
 * `AWAITING_UPFRONT` (the 50% before delivery) and `OVERAGE_PENDING` (goods held
 * over a receipt above the agreed basket) were retired with the downpayment on
 * 2026-10-08. Neither is ever reported now, so the apps' waits on them never
 * start, including on builds installed before the change.
 */
export type PaymentPlanState = "AWAITING_BALANCE" | "SETTLED" | "REFUNDED" | "CANCELLED";

export interface PaymentPlanSummary {
  /**
   * What had to arrive before delivery. Always 0 since the downpayment was
   * retired; kept because installed rider and customer apps still read it.
   */
  dueUpFront: number;
  /** UPFRONT + TOP_UP + FINAL, less REFUND. Money actually in hand. */
  amountPaid: number;
  /** What is still owed on the whole bill. Never negative. */
  balanceDue: number;
  state: PaymentPlanState;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * An escalation raised and not since cleared.
 *
 * Lives in this dependency-free pattern module rather than errandPaymentService
 * (which pulls in errandService and, through it, the routing/JWT-config chain)
 * so a small, pure predicate doesn't drag a heavy import graph into anything
 * that only wants to know whether an overage is pending.
 */
export function isOveragePending(errand: {
  overageEscalatedAt: Date | null;
  overageResolvedAt: Date | null;
}): boolean {
  if (!errand.overageEscalatedAt) return false;
  if (!errand.overageResolvedAt) return true;
  // Re-escalation after an earlier resolution: the later stamp wins, so a second
  // overage on the same errand is not silently treated as already handled.
  return errand.overageResolvedAt < errand.overageEscalatedAt;
}

/**
 * Where an errand's money currently stands.
 *
 * Pure, so the arithmetic can be tested without a database and so every surface
 * — customer, dispatcher, rider — reads one derivation instead of three. The
 * caller supplies the facts; this decides nothing about who may be charged what.
 *
 * `amountPaid` counts TOP_UP and FINAL alongside UPFRONT because they are all
 * the same kind of money arriving for the same errand; they are separate KINDS
 * so the ledger can say why each one was collected, not so they can be counted
 * apart.
 */
export function summarisePaymentPlan(input: {
  /** Goods + all fees + tip: the whole bill. */
  grandTotal: number;
  entries: LedgerEntry[];
  /** A cancelled errand's money is owed back, not collected. */
  cancelled?: boolean;
}): PaymentPlanSummary {
  const { grandTotal, entries } = input;

  const paidIn = entries
    .filter((e) => e.kind === "UPFRONT" || e.kind === "TOP_UP" || e.kind === "FINAL")
    .reduce((sum, e) => sum + e.amount, 0);
  const refunded = entries
    .filter((e) => e.kind === "REFUND")
    .reduce((sum, e) => sum + e.amount, 0);

  const amountPaid = round2(paidIn - refunded);

  // Never negative: an over-collection is a variance for the settlement report
  // to explain, not a negative amount owing that a rider might try to hand back.
  const balanceDue = round2(Math.max(0, grandTotal - amountPaid));

  // REFUNDED turns on money ever paid IN, not on the net amountPaid. After the
  // refund row lands, amountPaid is back to 0, and keying on it would tell a
  // customer who paid and got it back that no payment was ever collected.
  const state: PaymentPlanState = input.cancelled
    ? paidIn > 0
      ? "REFUNDED"
      : "CANCELLED"
    : balanceDue > 0
      ? "AWAITING_BALANCE"
      : "SETTLED";

  return { dueUpFront: 0, amountPaid, balanceDue, state };
}
