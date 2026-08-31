import { describe, expect, it } from "vitest";
import { buildFeeBreakdown, type PricedErrand } from "../src/services/patterns/feeBreakdown.js";
import { StandardPricingStrategy } from "../src/services/patterns/pricingStrategy.js";
import type { RateConfigValues } from "../src/services/patterns/pricingStrategy.js";

const RATES: RateConfigValues = {
  baseFee: 50,
  perKmRate: 10,
  multiStoreFeePerStore: 30,
  maxAdditionalStores: 2,
  groceryFeeThreshold: 3000,
  groceryFeePercent: 10,
  groceryFeeFlat: 50,
  nonCodThreshold: 3000,
  nonCodFeeHigh: 50,
  nonCodFeeLow: 15,
};

function priced(overrides: Partial<PricedErrand> = {}): PricedErrand {
  return {
    deliveryFee: 130,
    estimatedCost: 500,
    tip: 20,
    multiStoreFee: 30,
    groceryFee: 50,
    nonCodFee: 0,
    distanceFee: 0,
    feeCalculatedAt: new Date(),
    routedAt: new Date(),
    ...overrides,
  };
}

describe("grocery fee: flat below the threshold, percentage at or above", () => {
  // Priced past the size gate — more than 20 units OR at least ₱1,000 — so
  // these cases exercise the flat/percentage switch rather than whether a
  // handling fee applies at all.
  const fee = (estimatedCost: number, itemUnits = 20) =>
    new StandardPricingStrategy().calculate(
      { estimatedCost, itemUnits, tip: 0, storeCount: 1, distanceKm: 0, isCod: true },
      RATES
    ).groceryFee;

  it("charges the flat fee for a small basket", () => {
    // One predictable handling charge: a small basket is much the same work
    // whatever it costs.
    expect(fee(1000)).toBe(50);
    expect(fee(1500)).toBe(50);
    expect(fee(2999)).toBe(50);
  });

  it("charges nothing at all for an order too small to be a shop", () => {
    // Three meals off a counter. Below the gate no handling fee applies, which
    // is what stopped a flat ₱50 landing on a ₱176 fast-food order.
    expect(fee(176, 3)).toBe(0);
    // Neither the list nor the amount reaches its threshold.
    expect(fee(999, 20)).toBe(0);
  });

  it("charges the percentage once the basket reaches the threshold", () => {
    // A large basket ties up proportionally more company cash, so it scales.
    expect(fee(3000)).toBe(300); // 3000 x 10%
    expect(fee(5000)).toBe(500);
    expect(fee(10000)).toBe(1000);
  });

  it("switches at the threshold, not one peso either side of it", () => {
    expect(fee(2999)).toBe(50); // flat
    expect(fee(3000)).toBe(300); // percentage — the boundary is inclusive
  });

  it("charges nothing when there is no basket yet", () => {
    // A quote made before the customer has priced their items must not carry a
    // handling fee for handling nothing. Zero is "not known yet", not "small".
    expect(fee(0)).toBe(0);
  });

  it("is the inverse of the rule it replaced", () => {
    // Guards against a revert: under the OLD rule a small basket paid the
    // percentage and a large one was capped flat. If either of these two ever
    // flips back, this fails loudly rather than quietly repricing every errand.
    expect(fee(1000)).not.toBe(100); // would have been 1000 x 10%
    expect(fee(8000)).not.toBe(50); // would have been the flat cap
  });
});

describe("the fee components reconstitute the delivery fee", () => {
  it.each([
    { label: "single store, short trip", estimatedCost: 0, tip: 0, storeCount: 1, distanceKm: 1.2, isCod: true },
    { label: "three stores, long trip", estimatedCost: 850, tip: 30, storeCount: 3, distanceKm: 7.4, isCod: true },
    { label: "large grocery run", estimatedCost: 4200, tip: 0, storeCount: 2, distanceKm: 3.1, isCod: true },
    { label: "non-COD", estimatedCost: 1500, tip: 15, storeCount: 1, distanceKm: 2.0, isCod: false },
  ])("$label", ({ estimatedCost, tip, storeCount, distanceKm, isCod }) => {
    const b = new StandardPricingStrategy().calculate(
      { estimatedCost, tip, storeCount, distanceKm, isCod },
      RATES
    );

    // The invariant the persisted columns rely on: the five components ARE the
    // delivery fee. If a new component is ever added without being returned
    // here, this fails rather than silently producing a breakdown that does not
    // add up on the customer's screen.
    const sum = b.baseFee + b.multiStoreFee + b.groceryFee + b.nonCodFee + b.distanceFee;
    expect(sum).toBeCloseTo(b.deliveryFee, 6);

    // And the total is the fee plus the two things that are not fees.
    expect(b.totalCost).toBeCloseTo(b.deliveryFee + estimatedCost + tip, 6);
  });
});

describe("buildFeeBreakdown", () => {
  it("keeps the item money out of the fee subtotal", () => {
    // The rule the whole separation exists for: what the customer paid for goods
    // is never part of what they paid for service.
    const view = buildFeeBreakdown(priced({ estimatedCost: 3000 }));

    expect(view.fees.subtotal).toBe(130);
    expect(view.itemsSubtotal).toBe(3000);
    expect(view.fees.subtotal).toBeLessThan(view.itemsSubtotal);
  });

  it("adds up to the grand total", () => {
    const view = buildFeeBreakdown(priced());
    expect(view.grandTotal).toBe(view.fees.subtotal + view.itemsSubtotal + view.tip);
    expect(view.grandTotal).toBe(650); // 130 + 500 + 20
  });

  it("derives baseFee as whatever the components do not explain", () => {
    const view = buildFeeBreakdown(priced({ deliveryFee: 130, multiStoreFee: 30, groceryFee: 50, nonCodFee: 0, distanceFee: 0 }));
    expect(view.fees.baseFee).toBe(50);

    const parts =
      view.fees.baseFee + view.fees.distanceFee + view.fees.multiStoreFee + view.fees.groceryFee + view.fees.nonCodFee;
    expect(parts).toBeCloseTo(view.fees.subtotal, 6);
  });

  it("still balances for an errand priced before the components existed", () => {
    // Legacy rows have deliveryFee but null components. baseFee absorbs the whole
    // fee rather than the breakdown silently under-reporting it.
    const view = buildFeeBreakdown(
      priced({ multiStoreFee: null, groceryFee: null, nonCodFee: null, distanceFee: null, feeCalculatedAt: null })
    );

    expect(view.fees.baseFee).toBe(130);
    expect(view.fees.subtotal).toBe(130);
    expect(view.isFinal).toBe(false);
  });

  it("is not final until a real route has been measured", () => {
    // Distance is unknown until the dispatcher pins stores, so a price quoted
    // before that is genuinely provisional and clients must say so.
    expect(buildFeeBreakdown(priced({ routedAt: null })).isFinal).toBe(false);
    expect(buildFeeBreakdown(priced({ feeCalculatedAt: null })).isFinal).toBe(false);
    expect(buildFeeBreakdown(priced()).isFinal).toBe(true);
  });
});
