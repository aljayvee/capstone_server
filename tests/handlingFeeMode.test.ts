import { describe, expect, it } from "vitest";
import {
  resolveHandlingFee,
  StandardPricingStrategy,
  type HandlingFeeMode,
  type RateConfigValues,
} from "../src/services/patterns/pricingStrategy.js";

// Mirrors the live rate_configs row: ₱50 flat at ₱1,000, 10% from ₱1,001.
const RATES: RateConfigValues = {
  baseFee: 70,
  perKmRate: 10,
  multiStoreFeePerStore: 30,
  maxAdditionalStores: 2,
  groceryFeeThreshold: 1001,
  groceryFeePercent: 10,
  groceryFeeFlat: 50,
  nonCodThreshold: 3000,
  nonCodFeeHigh: 50,
  nonCodFeeLow: 15,
};

/**
 * Prices a basket already past the size gate, so these cases exercise the MODE
 * rules rather than the gate. The gate needs BOTH more than 12 units and at
 * least ₱1,000, so every basket here is at or above ₱1,000 too; the gate itself
 * is covered in its own block below.
 */
const fee = (basket: number, modes?: HandlingFeeMode[], units = 20) =>
  resolveHandlingFee(basket, units, modes, RATES);

describe("handling fee per mode", () => {
  it.each([
    { mode: "FLAT" as const, basket: 1500, expected: 50 },
    { mode: "FLAT" as const, basket: 9000, expected: 50 },
    { mode: "PERCENT" as const, basket: 1500, expected: 150 },
    { mode: "PERCENT" as const, basket: 9000, expected: 900 },
    // NONE is absolute: a category the owner marked exempt pays nothing at any
    // basket size. These rows are past the size gate and still charge zero.
    //
    // This reversed a prior rule that coerced NONE to THRESHOLD above the gate.
    // The owner scopes the handling fee to groceries, and "groceries only"
    // cannot hold if every exempt category re-prices the moment a basket clears
    // ₱1,000. See resolveHandlingFee.
    { mode: "NONE" as const, basket: 1500, expected: 0 },
    { mode: "NONE" as const, basket: 9000, expected: 0 },
    { mode: "THRESHOLD" as const, basket: 1000, expected: 50 },
    // Just past the crossover marginal relief holds the fee down; the plain
    // percentage resumes above ~₱1,055. See the relief block in
    // handlingFeeDecision.test.ts.
    { mode: "THRESHOLD" as const, basket: 1001, expected: 51 },
    { mode: "THRESHOLD" as const, basket: 2000, expected: 200 },
  ])("$mode on a ₱$basket basket charges ₱$expected", ({ mode, basket, expected }) => {
    expect(fee(basket, [mode])).toBe(expected);
  });
});

describe("mixed-category errands", () => {
  it("takes the most expensive applicable mode", () => {
    // A grocery stop (PERCENT) plus a pharmacy stop (FLAT) on a ₱1,000 basket.
    // Items carry no individual price, so the basket cannot be split between the
    // two — the grocery treatment wins because such an errand is substantially a
    // grocery run.
    expect(fee(1000, ["PERCENT", "FLAT"])).toBe(100);
    expect(fee(1000, ["FLAT", "PERCENT"])).toBe(100); // order must not matter
  });

  it("still works when the threshold mode is the expensive one", () => {
    // At ₱5,000 THRESHOLD behaves as a percentage and FLAT stays ₱50, so the max
    // is the threshold branch. Computing each mode's fee and taking the largest
    // handles this without a precedence table.
    expect(fee(5000, ["FLAT", "THRESHOLD"])).toBe(500);
  });

  it("keeps exempting a NONE category however big the order", () => {
    // Fast Food and Pharmacy are NONE and stay NONE. A large fast-food order
    // still pays base, distance and multi-store fees — the costs it actually
    // creates — but no handling fee, because the owner scoped that fee to
    // groceries.
    expect(fee(2000, ["NONE"])).toBe(0);
  });

  it("still charges when a NONE category is mixed with a charging one", () => {
    // A pharmacy stop (NONE) alongside a supermarket stop (FLAT) is
    // substantially a grocery run, and Math.max picks the charging mode. The
    // exemption covers a category, not a whole errand that merely touches it.
    expect(fee(2000, ["NONE", "FLAT"])).toBe(50);
    expect(fee(2000, ["FLAT", "NONE"])).toBe(50); // order must not matter
  });
});

describe("fallbacks", () => {
  it.each([
    { label: "undefined", modes: undefined },
    { label: "empty", modes: [] as HandlingFeeMode[] },
  ])("falls back to THRESHOLD when categoryModes is $label", ({ modes }) => {
    // Pins the pre-existing behaviour. 8 live rows still carry a retired "test1"
    // storeCategory that resolves to nothing — they must price as they always
    // have rather than throwing or going free.
    expect(fee(1000, modes)).toBe(50);
    expect(fee(2000, modes)).toBe(200);
  });

  it("charges nothing for a basket that has not been priced yet", () => {
    // Zero means "the customer has not costed their items", not "a small
    // purchase" — a quote taken before then must not carry a handling fee.
    for (const mode of ["FLAT", "PERCENT", "THRESHOLD", "NONE"] as HandlingFeeMode[]) {
      expect(fee(0, [mode])).toBe(0);
    }
  });
});

describe("the wider breakdown still balances", () => {
  it("keeps components summing to deliveryFee whatever the mode", () => {
    for (const mode of ["FLAT", "PERCENT", "THRESHOLD", "NONE"] as HandlingFeeMode[]) {
      const b = new StandardPricingStrategy().calculate(
        { estimatedCost: 4200, tip: 25, storeCount: 3, distanceKm: 5, isCod: false, categoryModes: [mode] },
        RATES
      );

      const parts = b.baseFee + b.multiStoreFee + b.groceryFee + b.nonCodFee + b.distanceFee;
      expect(parts).toBeCloseTo(b.deliveryFee, 6);

      // The invariant that matters most: the basket is never folded into a fee.
      expect(b.totalCost).toBeCloseTo(b.deliveryFee + 4200 + 25, 6);
      expect(b.groceryFee).toBeLessThan(4200);
    }
  });
});


describe("the size gate", () => {
  // Nothing is charged for handling until an errand is either a long list or a
  // meaningful amount of company money. Either alone is enough.

  it("charges nothing for a small, cheap order whatever the category", () => {
    for (const mode of ["FLAT", "PERCENT", "THRESHOLD", "NONE"] as HandlingFeeMode[]) {
      expect(fee(800, [mode], 5)).toBe(0);
    }
  });

  it("charges for a long list even when it is cheap", () => {
    // Twenty-five sachets of shampoo: little money, but a trolley and a queue.
    expect(fee(800, ["THRESHOLD"], 25)).toBe(50);
  });

  it("charges for a valuable basket even when it is short", () => {
    // Two items at five thousand pesos is company money the rider carries.
    expect(fee(5000, ["THRESHOLD"], 2)).toBe(500);
  });

  it("sits exactly on both boundaries", () => {
    // Twenty units is not "more than twenty".
    expect(fee(800, ["THRESHOLD"], 20)).toBe(0);
    expect(fee(800, ["THRESHOLD"], 21)).toBe(50);
    // The amount is compared in whole pesos, so ₱999.99 IS a thousand pesos.
    expect(fee(999.99, ["THRESHOLD"], 3)).toBe(50);
    expect(fee(1000, ["THRESHOLD"], 3)).toBe(50);
  });

  it("rounds the basket to the nearest peso before testing it", () => {
    // A centavo must not be what decides whether a fee applies at all.
    expect(fee(999.49, ["THRESHOLD"], 3)).toBe(0);
    expect(fee(999.5, ["THRESHOLD"], 3)).toBe(50);
  });

  it("still switches to the percentage on a big basket", () => {
    expect(fee(1000, ["THRESHOLD"], 3)).toBe(50);
    expect(fee(2000, ["THRESHOLD"], 3)).toBe(200);
  });

  it("rounds at the percentage switch too, so both thresholds agree", () => {
    // ₱1,000.50 is ₱1,001 on a receipt, and the size gate and the percentage
    // switch must not disagree about what a peso figure means.
    expect(fee(1000.49, ["THRESHOLD"], 3)).toBe(50);
    expect(fee(1000.5, ["THRESHOLD"], 3)).toBe(51);
  });

  it("exempts a fast-food order of the size people actually place", () => {
    // The ₱176 Jollibee run that started this: two meals, where a flat ₱50 was
    // nearly a third of the goods.
    expect(fee(176, ["NONE"], 3)).toBe(0);
  });
});
