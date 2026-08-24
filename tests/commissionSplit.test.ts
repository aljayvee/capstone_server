import { describe, expect, it } from "vitest";
import { RIDER_SHARE_RATE, splitCommission } from "../src/services/patterns/commissionSplit.js";

describe("splitCommission", () => {
  it("splits the fee and hands over the whole tip", () => {
    // The worked example from the requirement.
    const split = splitCommission({ deliveryFee: 100, tip: 20, itemCost: 3000 });

    expect(split.riderShare).toBe(90); // 100 * 0.7 + 20
    expect(split.businessShare).toBe(30); // the remaining 30% of the fee
    expect(split.itemCostExcluded).toBe(3000);
  });

  it("never lets item money reach either share", () => {
    // The defect this replaced: splitRiderBusinessShare(totalCost) was handed
    // 3120 here and credited the rider 2184 — ₱2,100 of which was the company's
    // own float for the groceries.
    const split = splitCommission({ deliveryFee: 100, tip: 20, itemCost: 3000 });

    expect(split.riderShare + split.businessShare).toBe(120); // fee + tip, nothing more
    expect(split.riderShare).toBeLessThan(3000);
    expect(split.businessShare).toBeLessThan(3000);
  });

  it("is unaffected by the size of the purchase", () => {
    // Two identical deliveries differing only in what was bought must pay the
    // rider identically. This is the property the old signature could not hold.
    const cheap = splitCommission({ deliveryFee: 75, tip: 0, itemCost: 50 });
    const expensive = splitCommission({ deliveryFee: 75, tip: 0, itemCost: 9500 });

    expect(cheap.riderShare).toBe(expensive.riderShare);
    expect(cheap.businessShare).toBe(expensive.businessShare);
  });

  it("gives the business no part of a tip", () => {
    const withTip = splitCommission({ deliveryFee: 100, tip: 50, itemCost: 0 });
    const withoutTip = splitCommission({ deliveryFee: 100, tip: 0, itemCost: 0 });

    expect(withTip.businessShare).toBe(withoutTip.businessShare);
    expect(withTip.riderShare - withoutTip.riderShare).toBe(50);
  });

  it("keeps the two fee halves summing to the fee exactly", () => {
    // businessShare is the remainder rather than an independent × 0.3, so
    // rounding can never make the halves fail to reconstitute the fee.
    for (const deliveryFee of [0.01, 33.33, 49.99, 66.67, 99.99, 123.45, 1000.01]) {
      const split = splitCommission({ deliveryFee, tip: 0, itemCost: 0 });
      expect(split.riderShare + split.businessShare).toBeCloseTo(deliveryFee, 10);
    }
  });

  it("handles a zero-fee errand without inventing money", () => {
    const split = splitCommission({ deliveryFee: 0, tip: 0, itemCost: 500 });
    expect(split.riderShare).toBe(0);
    expect(split.businessShare).toBe(0);
    expect(split.itemCostExcluded).toBe(500);
  });

  it("reports the rate it applied", () => {
    // Stored on every snapshot, so a past payout stays explainable if the rate
    // ever changes.
    expect(splitCommission({ deliveryFee: 100, tip: 0, itemCost: 0 }).commissionRate).toBe(
      RIDER_SHARE_RATE
    );
    expect(RIDER_SHARE_RATE).toBe(0.7);
  });
});
