import type { PaymentPlanState } from "./paymentLedger.js";

/**
 * What customer_transactions.status may say. It answers one question for the
 * Transaction Summary report: where does the customer's money for this errand
 * stand? The errand's own lifecycle is a separate column (errandStatus), so
 * this one should not repeat it.
 */
export type TransactionStatus = "PENDING" | "PAID" | "SHORT" | "REFUNDED" | "CANCELLED";

export interface TransactionStatusInput {
  /** The errand's ErrandStatus: AVAILABLE ... DELIVERED, COMPLETED, CANCELLED. */
  errandStatus: string;
  /**
   * GCash / PayMaya / Bank Transfer: the ledger summary (summarisePaymentPlan,
   * already told whether the errand is cancelled). Null on cash on delivery,
   * which keeps no ledger.
   */
  ledger: { amountPaid: number; balanceDue: number; state: PaymentPlanState } | null;
  /**
   * The rider's cash settlement, once filed. Only exists after DELIVERED
   * (settlementService refuses one earlier), and on non-cash modes only when
   * the customer ended up paying the rider in cash.
   */
  settlement: { status: string } | null;
}

/**
 * Pure, so the rule can be tested without a database and every trigger
 * (status change, ledger row, cash settlement) reads the same answer.
 */
export function deriveTransactionStatus(input: TransactionStatusInput): TransactionStatus {
  const { errandStatus, ledger, settlement } = input;

  // Cancelled. The ledger already knows whether money came in and has to go
  // back. Cash on delivery keeps no ledger, and its cash changes hands only at
  // the door, which a cancelled errand never reached.
  if (errandStatus === "CANCELLED") {
    return ledger?.state === "REFUNDED" ? "REFUNDED" : "CANCELLED";
  }

  // Cash in the rider's hand. The settlement is the record of what was actually
  // collected, so it wins over a ledger that may still show a balance the
  // customer paid in cash rather than by transfer. OVER is still paid.
  if (settlement) {
    return settlement.status === "SHORT" ? "SHORT" : "PAID";
  }

  // Transfer modes: paid once nothing is owed. amountPaid > 0 so a bill that
  // has not been priced yet (total 0, so balance 0) never reads as paid.
  if (ledger && ledger.balanceDue === 0 && ledger.amountPaid > 0) {
    return "PAID";
  }
  return "PENDING";
}
