import { describe, expect, it } from "vitest";
import {
  resolveHandlingFee,
  StandardPricingStrategy,
  type HandlingFeeMode,
  type RateConfigValues,
} from "../src/services/patterns/pricingStrategy.js";

// Mirrors the live rate_configs row.
const RATES: RateConfigValues = {
  baseFee: 67,
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
    // NONE is an exemption for ordinary orders, not an absolute one: these rows
    // are all past the size gate, where it stops applying. Its exempting
    // behaviour is covered in "the size gate" below.
    { mode: "NONE" as const, basket: 1500, expected: 50 },
    { mode: "NONE" as const, basket: 9000, expected: 900 },
    { mode: "THRESHOLD" as const, basket: 2999, expected: 50 },
    { mode: "THRESHOLD" as const, basket: 3000, expected: 300 },
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

  it("stops exempting a NONE category once the order is big enough", () => {
    // Fast Food and Pharmacy are NONE, but the exemption covers the ordinary
    // order from them — two meals, one prescription. A 20-unit run past the
    // gate prices like any other shop.
    expect(fee(2000, ["NONE"])).toBe(50);
    expect(fee(2000, ["NONE", "FLAT"])).toBe(50);
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
    expect(fee(2999, modes)).toBe(50);
    expect(fee(3000, modes)).toBe(300);
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
    expect(fee(2999, ["THRESHOLD"], 3)).toBe(50);
    expect(fee(3000, ["THRESHOLD"], 3)).toBe(300);
  });

  it("rounds at the percentage switch too, so both thresholds agree", () => {
    // ₱2,999.99 is three thousand pesos on a receipt, and the two thresholds
    // must not disagree about what a peso figure means.
    expect(fee(2999.49, ["THRESHOLD"], 3)).toBe(50);
    expect(fee(2999.5, ["THRESHOLD"], 3)).toBe(300);
  });

  it("exempts a fast-food order of the size people actually place", () => {
    // The ₱176 Jollibee run that started this: two meals, where a flat ₱50 was
    // nearly a third of the goods.
    expect(fee(176, ["NONE"], 3)).toBe(0);
  });
});
