import { describe, expect, it } from "vitest";
import {
  summarisePaymentPlan,
  OVERAGE_ESCALATION_PESOS,
  type LedgerEntry,
} from "../src/services/patterns/paymentLedger.js";
import { hasPaymentLedger, PAYMENT_MODE_BANK, PAYMENT_MODE_COD, PAYMENT_MODE_GCASH } from "../src/services/patterns/paymentModes.js";

/**
 * The owner's rule since 2026-10-08: GCash / PayMaya and Bank Transfer are paid
 * the way cash on delivery is, the whole bill at the door. Nothing is owed
 * before delivery, and no state waits on the office.
 *
 * A worked example carried through most of these cases: ₱1,000 of groceries,
 * ₱70 base + ₱50 handling = ₱120 of fees, no tip. Bill ₱1,120.
 */
const GRAND_TOTAL = 1120;

const plan = (entries: LedgerEntry[], opts: { cancelled?: boolean } = {}) =>
  summarisePaymentPlan({ grandTotal: GRAND_TOTAL, entries, cancelled: opts.cancelled });

describe("nothing is owed before the door", () => {
  it("asks for no downpayment", () => {
    expect(plan([]).dueUpFront).toBe(0);
  });

  it("owes the whole bill at the door, fees included", () => {
    expect(plan([])).toMatchObject({ balanceDue: 1120, amountPaid: 0, state: "AWAITING_BALANCE" });
  });
});

describe("the bill paid at the door", () => {
  it("settles once the transfer the rider photographed is recorded", () => {
    expect(plan([{ kind: "FINAL", amount: 1120 }])).toMatchObject({ balanceDue: 0, state: "SETTLED" });
  });

  it("still counts a half paid before the change, so it is never asked for twice", () => {
    expect(plan([{ kind: "UPFRONT", amount: 500 }])).toMatchObject({
      amountPaid: 500,
      balanceDue: 620,
      state: "AWAITING_BALANCE",
    });
  });

  it("counts a top-up as money in", () => {
    expect(plan([{ kind: "TOP_UP", amount: 120 }]).balanceDue).toBe(1000);
  });

  it("gives a refund back", () => {
    expect(plan([
      { kind: "FINAL", amount: 1120 },
      { kind: "REFUND", amount: 200 },
    ]).amountPaid).toBe(920);
  });

  it("never goes negative", () => {
    expect(plan([{ kind: "FINAL", amount: 1500 }]).balanceDue).toBe(0);
  });

  it("rounds to centavos", () => {
    expect(plan([{ kind: "FINAL", amount: 333.333 }]).amountPaid).toBe(333.33);
  });
});

describe("what has to happen next", () => {
  it("reads as refunded once cancelled after money came in", () => {
    expect(plan([{ kind: "FINAL", amount: 1120 }], { cancelled: true }).state).toBe("REFUNDED");
  });

  it("reads as cancelled, not refunded, when nothing was ever paid", () => {
    expect(plan([], { cancelled: true }).state).toBe("CANCELLED");
  });

  it("stays refunded after the refund row brings the net paid back to zero", () => {
    const refunded = plan(
      [
        { kind: "UPFRONT", amount: 500 },
        { kind: "REFUND", amount: 500 },
      ],
      { cancelled: true }
    );
    expect(refunded.amountPaid).toBe(0);
    expect(refunded.state).toBe("REFUNDED");
  });

  it("never reports the retired waits the apps used to stop on", () => {
    const states = [plan([]), plan([{ kind: "UPFRONT", amount: 500 }]), plan([{ kind: "FINAL", amount: 1120 }])].map(
      (p) => p.state as string
    );
    expect(states).not.toContain("AWAITING_UPFRONT");
    expect(states).not.toContain("OVERAGE_PENDING");
  });
});

describe("which modes keep a ledger", () => {
  it("records GCash / PayMaya and Bank Transfer, not cash on delivery", () => {
    const mode = (name: string) => ({ paymentMode: { name } });
    expect(hasPaymentLedger(mode(PAYMENT_MODE_GCASH))).toBe(true);
    expect(hasPaymentLedger(mode(PAYMENT_MODE_BANK))).toBe(true);
    expect(hasPaymentLedger(mode(PAYMENT_MODE_COD))).toBe(false);
    expect(hasPaymentLedger(null)).toBe(false);
  });
});

describe("the overage floor", () => {
  it("matches the exception report's materiality", () => {
    // Still the line above which an overage is logged for the report, though it
    // no longer holds the goods.
    expect(OVERAGE_ESCALATION_PESOS).toBe(20);
  });
});
