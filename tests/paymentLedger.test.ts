import { describe, expect, it } from "vitest";
import {
  summarisePaymentPlan,
  DOWNPAYMENT_RATE,
  OVERAGE_ESCALATION_PESOS,
  type LedgerEntry,
} from "../src/services/patterns/paymentLedger.js";

/**
 * The owner's rule: the customer pays half the GOODS through the Facebook Page
 * before a rider is sent, and the rider collects everything else at the door.
 *
 * A worked example carried through most of these cases: ₱1,000 of groceries,
 * ₱70 base + ₱50 handling = ₱120 of fees, no tip. Goods ₱1,000, bill ₱1,120,
 * downpayment ₱500, balance ₱620.
 */
const GOODS = 1000;
const GRAND_TOTAL = 1120;

const plan = (entries: LedgerEntry[], opts: { overagePending?: boolean; cancelled?: boolean } = {}) =>
  summarisePaymentPlan({
    goodsSubtotal: GOODS,
    grandTotal: GRAND_TOTAL,
    entries,
    overagePending: opts.overagePending ?? false,
    cancelled: opts.cancelled,
  });

describe("what the customer pays up front", () => {
  it("is half the goods, not half the bill", () => {
    // The fees ride with the balance. Half of ₱1,120 would be ₱560 — this is
    // ₱500, because the rule is about the purchase, not the invoice.
    expect(plan([]).dueUpFront).toBe(500);
    expect(DOWNPAYMENT_RATE).toBe(0.5);
  });

  it("rounds to centavos", () => {
    const odd = summarisePaymentPlan({
        goodsSubtotal: 999.99,
      grandTotal: 1119.99,
      entries: [],
      overagePending: false,
    });

    expect(odd.dueUpFront).toBe(500);
  });
});

describe("the balance the rider collects", () => {
  it("is the whole bill before anything is paid", () => {
    expect(plan([]).balanceDue).toBe(1120);
  });

  it("drops by the downpayment", () => {
    const p = plan([{ kind: "UPFRONT", amount: 500 }]);

    expect(p.amountPaid).toBe(500);
    expect(p.balanceDue).toBe(620);
  });

  it("counts a top-up as money in, the same as a downpayment", () => {
    // Separate KINDS so the ledger can say why each was collected — not so they
    // are counted apart.
    const p = plan([
      { kind: "UPFRONT", amount: 500 },
      { kind: "TOP_UP", amount: 100 },
    ]);

    expect(p.amountPaid).toBe(600);
    expect(p.balanceDue).toBe(520);
  });

  it("gives a refund back", () => {
    const p = plan([
      { kind: "UPFRONT", amount: 500 },
      { kind: "REFUND", amount: 200 },
    ]);

    expect(p.amountPaid).toBe(300);
    expect(p.balanceDue).toBe(820);
  });

  it("never goes negative", () => {
    // An over-collection is a settlement variance for the report to explain, not
    // a negative amount owing that a rider might try to hand back at the door.
    const p = plan([
      { kind: "UPFRONT", amount: 500 },
      { kind: "FINAL", amount: 700 },
    ]);

    expect(p.amountPaid).toBe(1200);
    expect(p.balanceDue).toBe(0);
  });
});

describe("what has to happen next", () => {
  it("waits on the downpayment before anything else", () => {
    expect(plan([]).state).toBe("AWAITING_UPFRONT");
  });

  it("waits on the balance once the downpayment lands", () => {
    expect(plan([{ kind: "UPFRONT", amount: 500 }]).state).toBe("AWAITING_BALANCE");
  });

  it("settles when nothing is owed", () => {
    const p = plan([
      { kind: "UPFRONT", amount: 500 },
      { kind: "FINAL", amount: 620 },
    ]);

    expect(p.balanceDue).toBe(0);
    expect(p.state).toBe("SETTLED");
  });

  it("holds for an overage whatever the arithmetic says", () => {
    // The goods are held because the company fronted money the customer never
    // agreed to — a healthy-looking balance does not release them.
    const p = plan([{ kind: "UPFRONT", amount: 500 }], { overagePending: true });

    expect(p.state).toBe("OVERAGE_PENDING");
  });

  it("still reports the downpayment as missing even during an overage", () => {
    // Ordering matters: an unpaid downpayment is the more basic problem, and
    // telling a dispatcher to chase a top-up first would be the wrong instruction.
    const p = plan([], { overagePending: true });

    expect(p.state).toBe("AWAITING_UPFRONT");
  });

  it("reads as refunded once cancelled, whatever else is true", () => {
    const p = plan([{ kind: "UPFRONT", amount: 500 }], {
      overagePending: true,
      cancelled: true,
    });

    expect(p.state).toBe("REFUNDED");
  });
});

describe("the overage floor", () => {
  it("matches the exception report's materiality", () => {
    // One number for "worth a person's attention" across the system. Below it
    // the company absorbs a few pesos rather than holding a rider at a door over
    // small change.
    expect(OVERAGE_ESCALATION_PESOS).toBe(20);
  });
});

describe('every non-COD channel runs one arrangement', () => {
  // GCash and Bank Transfer are settled identically: half the goods before a
  // rider is sent, the balance at the door. There is no second arrangement, and
  // therefore no plan kind to pass in — which is why summarisePaymentPlan takes
  // the facts and nothing else.
  it('always takes half the goods, never half the invoice', () => {
    // Half of ₱1,120 would be ₱560. The rule is about the purchase.
    expect(plan([]).dueUpFront).toBe(500);
  });

  it('leaves the fees with the balance the rider collects', () => {
    const p = plan([{ kind: 'UPFRONT', amount: 500 }]);
    // ₱1,000 goods + ₱120 fees, ₱500 paid: the ₱620 balance carries every fee.
    expect(p.balanceDue).toBe(620);
  });
});
