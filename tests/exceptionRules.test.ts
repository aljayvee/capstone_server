import { describe, expect, it } from "vitest";
import {
  MATERIALITY_PESOS,
  exceptionRate,
  isMaterial,
  isMoneyException,
  isReceiptDivergent,
  rankExceptions,
  receiptDivergenceThreshold,
  type ErrandException,
} from "../src/services/patterns/exceptionRules.js";

const at = (iso: string) => new Date(iso);

const exception = (over: Partial<ErrandException> = {}): ErrandException => ({
  errandId: "ERR-1",
  kind: "CASH_VARIANCE",
  amountAtRisk: 0,
  detail: "",
  riderId: 7,
  riderName: "Mark",
  occurredAt: at("2026-08-25T02:00:00Z"),
  resolvedAt: null,
  resolvedBy: null,
  resolutionReason: null,
  ...over,
});

describe("which occurrences reach a person", () => {
  it("hides a rounding variance and shows a real shortfall", () => {
    // A ₱1 variance beside a ₱2,000 one is what makes a queue unreadable.
    expect(isMaterial("CASH_VARIANCE", 1)).toBe(false);
    expect(isMaterial("CASH_VARIANCE", 2000)).toBe(true);
  });

  it("sits exactly on the threshold", () => {
    expect(isMaterial("CASH_VARIANCE", MATERIALITY_PESOS - 0.01)).toBe(false);
    expect(isMaterial("CASH_VARIANCE", MATERIALITY_PESOS)).toBe(true);
  });

  it("shows conduct exceptions at any amount, including none", () => {
    // A wrong-branch visit is worth seeing whatever it cost; the amount is not
    // what makes it interesting.
    for (const kind of ["WRONG_BRANCH", "UNVERIFIED_PURCHASE", "MISSING_RECEIPT", "STALLED_STOP"] as const) {
      expect(isMaterial(kind, 0)).toBe(true);
      expect(isMaterial(kind, 1)).toBe(true);
    }
  });

  it("judges an over-collection as harshly as a shortfall", () => {
    // Cash the rider should not be holding is an exception in either direction.
    expect(isMaterial("CASH_VARIANCE", -2000)).toBe(true);
  });

  it("knows which kinds are about money", () => {
    expect(isMoneyException("CASH_VARIANCE")).toBe(true);
    expect(isMoneyException("RECEIPT_DIVERGENCE")).toBe(true);
    expect(isMoneyException("WRONG_BRANCH")).toBe(false);
    expect(isMoneyException("UNVERIFIED_PURCHASE")).toBe(false);
  });
});

describe("receipt divergence uses the rule dispatch already sees", () => {
  it("is the greater of ₱100 or 20 percent", () => {
    // Small basket: the flat ₱100 floor governs.
    expect(receiptDivergenceThreshold(176)).toBe(100);
    // Large basket: 20% is the greater figure.
    expect(receiptDivergenceThreshold(5000)).toBe(1000);
  });

  it("stays silent on the digit misreads that happen routinely", () => {
    // OCR misreading a digit on creased thermal paper is ordinary, and alerting
    // on those trains dispatch to ignore the alert.
    expect(isReceiptDivergent(176, 180)).toBe(false);
    expect(isReceiptDivergent(994, 1000)).toBe(false);
  });

  it("fires when the rider's figure is genuinely far off", () => {
    expect(isReceiptDivergent(176, 900)).toBe(true);
    expect(isReceiptDivergent(5000, 3000)).toBe(true);
  });

  it("fires in both directions", () => {
    expect(isReceiptDivergent(1000, 1500)).toBe(true);
    expect(isReceiptDivergent(1500, 1000)).toBe(true);
  });
});

describe("the order a queue is read in", () => {
  it("puts the most money at the top", () => {
    const ranked = rankExceptions([
      exception({ errandId: "small", amountAtRisk: 60 }),
      exception({ errandId: "large", amountAtRisk: 2000 }),
      exception({ errandId: "middle", amountAtRisk: 400 }),
    ]);
    expect(ranked.map((e) => e.errandId)).toEqual(["large", "middle", "small"]);
  });

  it("surfaces the oldest of the amountless ones first", () => {
    // Conduct exceptions carry no amount and would otherwise sink forever. A
    // thing flagged three weeks ago and never cleared is what this list is for.
    const ranked = rankExceptions([
      exception({ errandId: "recent", kind: "WRONG_BRANCH", occurredAt: at("2026-08-25T02:00:00Z") }),
      exception({ errandId: "old", kind: "WRONG_BRANCH", occurredAt: at("2026-08-04T02:00:00Z") }),
    ]);
    expect(ranked.map((e) => e.errandId)).toEqual(["old", "recent"]);
  });

  it("does not mutate the list it was given", () => {
    const input = [exception({ amountAtRisk: 1 }), exception({ amountAtRisk: 99 })];
    rankExceptions(input);
    expect(input[0].amountAtRisk).toBe(1);
  });

  it("handles an empty queue", () => {
    expect(rankExceptions([])).toEqual([]);
  });
});

describe("a rider's exposure as a rate", () => {
  it("does not punish a rider for working more", () => {
    // 2 in 4 is a pattern; 3 in 40 is bad luck. Counting alone reverses that.
    const busy = exceptionRate(3, 40);
    const occasional = exceptionRate(2, 4);
    expect(occasional).toBeGreaterThan(busy);
  });

  it("reads as a proportion", () => {
    expect(exceptionRate(1, 4)).toBe(0.25);
    expect(exceptionRate(0, 40)).toBe(0);
  });

  it("returns zero rather than dividing by nothing", () => {
    // A rider with no completed work has no pattern yet, and inventing one from
    // an empty denominator accuses someone of nothing.
    expect(exceptionRate(0, 0)).toBe(0);
    expect(exceptionRate(3, 0)).toBe(0);
    expect(exceptionRate(1, -5)).toBe(0);
  });
});
