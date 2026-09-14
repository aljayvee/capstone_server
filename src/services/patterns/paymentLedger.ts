export type ErrandPaymentKindValue = "UPFRONT" | "TOP_UP" | "FINAL" | "REFUND";

/** One ledger row, reduced to what the arithmetic needs. */
export interface LedgerEntry {
  kind: ErrandPaymentKindValue;
  amount: number;
}

/**
 * The share of the goods a customer pays before the rider buys anything.
 *
 * Half, per the owner's rule: "the payment starts after half of the purchase".
 * Taken on the GOODS only — the delivery and service fees fall due with the
 * balance, which the rider collects at the door.
 */
export const DOWNPAYMENT_RATE = 0.5;

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
 * Five states, each one a different thing somebody has to do next:
 *
 *  - `AWAITING_UPFRONT`  — the dispatcher is waiting on the Facebook Page.
 *  - `OVERAGE_PENDING`   — the receipt beat the agreement; the office owes the
 *                          customer a conversation and the rider is standing
 *                          still until it happens.
 *  - `AWAITING_BALANCE`  — money is owed and the rider will collect it.
 *  - `SETTLED`           — nothing owed.
 *  - `REFUNDED`          — cancelled; money goes back.
 */
export type PaymentPlanState =
  | "AWAITING_UPFRONT"
  | "OVERAGE_PENDING"
  | "AWAITING_BALANCE"
  | "SETTLED"
  | "REFUNDED";

export interface PaymentPlanSummary {
  /**
   * What must arrive before a rider is sent: half the GOODS.
   *
   * Half the purchase, not half the invoice — the delivery and service fees ride
   * with the balance the rider collects at the door.
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
  /** The goods figure the 50% downpayment is taken on. */
  goodsSubtotal: number;
  /** Goods + all fees + tip: the whole bill. */
  grandTotal: number;
  entries: LedgerEntry[];
  /** An unresolved receipt overage holds the goods regardless of what is paid. */
  overagePending: boolean;
  /** A cancelled errand's money is owed back, not collected. */
  cancelled?: boolean;
}): PaymentPlanSummary {
  const { goodsSubtotal, grandTotal, entries, overagePending } = input;

  const paidIn = entries
    .filter((e) => e.kind === "UPFRONT" || e.kind === "TOP_UP" || e.kind === "FINAL")
    .reduce((sum, e) => sum + e.amount, 0);
  const refunded = entries
    .filter((e) => e.kind === "REFUND")
    .reduce((sum, e) => sum + e.amount, 0);

  const amountPaid = round2(paidIn - refunded);

  const dueUpFront = round2(goodsSubtotal * DOWNPAYMENT_RATE);

  // Never negative: an over-collection is a variance for the settlement report
  // to explain, not a negative amount owing that a rider might try to hand back.
  const balanceDue = round2(Math.max(0, grandTotal - amountPaid));

  const hasUpfront = entries.some((e) => e.kind === "UPFRONT");

  // Ordered by which fact overrides which. An unresolved overage outranks a
  // healthy balance: the goods are held whatever the arithmetic says, because
  // the company has fronted money the customer has not agreed to.
  const state: PaymentPlanState = input.cancelled
    ? "REFUNDED"
    : !hasUpfront
      ? "AWAITING_UPFRONT"
      : overagePending
        ? "OVERAGE_PENDING"
        : balanceDue > 0
          ? "AWAITING_BALANCE"
          : "SETTLED";

  return { dueUpFront, amountPaid, balanceDue, state };
}
