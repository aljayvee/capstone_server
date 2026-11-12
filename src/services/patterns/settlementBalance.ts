/**
 * What happened to a short handover after the fact, and what is still owed.
 *
 * A SettlementRecord is the cash as counted at the handover and is never
 * edited. Money that settles part of a short later (the rider pays it back, the
 * customer pays it by GCash) or is written off is a SettlementAdjustment row.
 * Everything below is derived from those two, so the Help Desk, the Settlement
 * Report and the transaction status all read the same answer.
 *
 * Pure: no database, so the rule is tested on its own.
 */

export const ADJUSTMENT_KINDS = ["RIDER_PAID_BACK", "CUSTOMER_PAID_GCASH", "WRITTEN_OFF"] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/** How long the person who recorded an adjustment may undo it. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

/** Plain words for each kind, shared by the screen and the printout. */
export const ADJUSTMENT_LABEL: Record<AdjustmentKind, string> = {
  RIDER_PAID_BACK: "Rider paid back",
  CUSTOMER_PAID_GCASH: "Customer paid by GCash",
  WRITTEN_OFF: "Written off",
};

export interface AdjustmentLike {
  kind: string;
  amount: number;
  voidedAt: Date | null;
}

export interface SettlementBalance {
  /** How much the handover came back short. 0 for a matched or over handover. */
  short: number;
  riderPaidBack: number;
  customerPaid: number;
  writtenOff: number;
  /** short, less every adjustment still standing. Never below 0. */
  stillOwed: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function settlementBalance(
  variance: number,
  adjustments: AdjustmentLike[] | null | undefined
): SettlementBalance {
  const short = variance < 0 ? round2(-variance) : 0;
  const standing = (adjustments ?? []).filter((a) => !a.voidedAt);
  const sumOf = (kind: AdjustmentKind) =>
    round2(standing.filter((a) => a.kind === kind).reduce((sum, a) => sum + a.amount, 0));

  const riderPaidBack = sumOf("RIDER_PAID_BACK");
  const customerPaid = sumOf("CUSTOMER_PAID_GCASH");
  const writtenOff = sumOf("WRITTEN_OFF");

  return {
    short,
    riderPaidBack,
    customerPaid,
    writtenOff,
    stillOwed: Math.max(0, round2(short - riderPaidBack - customerPaid - writtenOff)),
  };
}

/**
 * Why an adjustment cannot be recorded, or null when it can. One rule for the
 * Resolve box and for "Record payment" later, so neither can let through what
 * the other refuses.
 */
export function adjustmentRefusal(
  balance: SettlementBalance,
  input: { kind: AdjustmentKind; amount: number; reference?: string | null }
): string | null {
  if (balance.short <= 0) return "Only a short cash handover can have money recorded against it.";
  if (balance.stillOwed <= 0) return "Nothing is owed on this handover any more.";
  if (!(input.amount > 0)) return "Enter an amount above zero.";
  // Half a centavo of slack, so a figure typed from the screen is never refused
  // for a rounding difference.
  if (input.amount > balance.stillOwed + 0.005) {
    return `That is more than is still owed (₱${balance.stillOwed.toFixed(2)}).`;
  }
  if (input.kind === "CUSTOMER_PAID_GCASH" && !input.reference?.trim()) {
    return "Enter the GCash reference number, so the payment can be checked.";
  }
  return null;
}

/** Whether `userId` may still undo an adjustment they recorded. */
export function canUndoAdjustment(
  adjustment: { recordedById: number; recordedAt: Date; voidedAt: Date | null },
  userId: number,
  now: Date = new Date()
): boolean {
  return (
    !adjustment.voidedAt &&
    adjustment.recordedById === userId &&
    now.getTime() - adjustment.recordedAt.getTime() <= UNDO_WINDOW_MS
  );
}
