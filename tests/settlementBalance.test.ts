import { describe, expect, it } from "vitest";
import {
  UNDO_WINDOW_MS,
  adjustmentRefusal,
  canUndoAdjustment,
  settlementBalance,
} from "../src/services/patterns/settlementBalance.js";
import { deriveTransactionStatus } from "../src/services/patterns/transactionStatus.js";

const adj = (kind: string, amount: number, voided = false) => ({
  kind,
  amount,
  voidedAt: voided ? new Date() : null,
});

describe("settlementBalance", () => {
  it("always adds up: short = paid back + paid by customer + written off + still owed", () => {
    const b = settlementBalance(-100, [
      adj("RIDER_PAID_BACK", 30),
      adj("CUSTOMER_PAID_GCASH", 20),
      adj("WRITTEN_OFF", 10),
    ]);

    expect(b).toEqual({ short: 100, riderPaidBack: 30, customerPaid: 20, writtenOff: 10, stillOwed: 40 });
    expect(b.riderPaidBack + b.customerPaid + b.writtenOff + b.stillOwed).toBe(b.short);
  });

  it("ignores an entry that was undone", () => {
    expect(settlementBalance(-60, [adj("RIDER_PAID_BACK", 60, true)]).stillOwed).toBe(60);
  });

  it("owes nothing on a matched or over handover", () => {
    expect(settlementBalance(0, []).stillOwed).toBe(0);
    expect(settlementBalance(25, []).short).toBe(0);
  });

  it("copes with no adjustments loaded", () => {
    expect(settlementBalance(-60, undefined).stillOwed).toBe(60);
  });
});

describe("adjustmentRefusal", () => {
  const owed60 = settlementBalance(-60, []);

  it("accepts a partial amount and the full amount", () => {
    expect(adjustmentRefusal(owed60, { kind: "RIDER_PAID_BACK", amount: 30 })).toBeNull();
    expect(adjustmentRefusal(owed60, { kind: "WRITTEN_OFF", amount: 60 })).toBeNull();
  });

  it("refuses more than is still owed", () => {
    expect(adjustmentRefusal(owed60, { kind: "RIDER_PAID_BACK", amount: 61 })).toMatch(/more than is still owed/);
    const owed20 = settlementBalance(-60, [adj("RIDER_PAID_BACK", 40)]);
    expect(adjustmentRefusal(owed20, { kind: "WRITTEN_OFF", amount: 30 })).toMatch(/₱20.00/);
  });

  it("refuses zero, a handover that was not short, and one already settled", () => {
    expect(adjustmentRefusal(owed60, { kind: "RIDER_PAID_BACK", amount: 0 })).toMatch(/above zero/);
    expect(adjustmentRefusal(settlementBalance(10, []), { kind: "RIDER_PAID_BACK", amount: 5 })).toMatch(
      /Only a short/
    );
    const settled = settlementBalance(-60, [adj("CUSTOMER_PAID_GCASH", 60)]);
    expect(adjustmentRefusal(settled, { kind: "RIDER_PAID_BACK", amount: 1 })).toMatch(/Nothing is owed/);
  });

  it("needs the GCash reference number for a customer payment", () => {
    expect(adjustmentRefusal(owed60, { kind: "CUSTOMER_PAID_GCASH", amount: 60 })).toMatch(/GCash reference/);
    expect(adjustmentRefusal(owed60, { kind: "CUSTOMER_PAID_GCASH", amount: 60, reference: "  " })).toMatch(
      /GCash reference/
    );
    expect(
      adjustmentRefusal(owed60, { kind: "CUSTOMER_PAID_GCASH", amount: 60, reference: "1012345678901" })
    ).toBeNull();
  });
});

describe("canUndoAdjustment", () => {
  const recordedAt = new Date("2026-10-22T07:00:00Z");
  const row = { recordedById: 7, recordedAt, voidedAt: null };

  it("lets the recorder undo within 10 minutes", () => {
    expect(canUndoAdjustment(row, 7, new Date(recordedAt.getTime() + UNDO_WINDOW_MS))).toBe(true);
  });

  it("refuses anyone else, after 10 minutes, or twice", () => {
    expect(canUndoAdjustment(row, 8, recordedAt)).toBe(false);
    expect(canUndoAdjustment(row, 7, new Date(recordedAt.getTime() + UNDO_WINDOW_MS + 1000))).toBe(false);
    expect(canUndoAdjustment({ ...row, voidedAt: new Date() }, 7, recordedAt)).toBe(false);
  });
});

describe("transaction status after a short", () => {
  const base = { errandStatus: "DELIVERED", ledger: null };

  it("turns Paid only when the customer has paid the whole short", () => {
    expect(deriveTransactionStatus({ ...base, settlement: { status: "SHORT" } })).toBe("SHORT");
    expect(
      deriveTransactionStatus({ ...base, settlement: { status: "SHORT", customerCoveredShort: true } })
    ).toBe("PAID");
  });

  it("stays Short when the rider paid it back or it was written off", () => {
    // The sync passes customerCoveredShort=false in both cases: the customer
    // still did not pay it, whatever the business recovered.
    expect(
      deriveTransactionStatus({ ...base, settlement: { status: "SHORT", customerCoveredShort: false } })
    ).toBe("SHORT");
  });
});
