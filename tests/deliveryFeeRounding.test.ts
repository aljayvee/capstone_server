import { describe, expect, it } from "vitest";
import { defaultPricingStrategy } from "../src/services/patterns/pricingStrategy.js";

// The live production schedule.
const RATE_CONFIG = {
  baseFee: 67,
  perKmRate: 10,
  multiStoreFeePerStore: 30,
  maxAdditionalStores: 2,
  groceryFeeThreshold: 3000,
  groceryFeePercent: 10,
  groceryFeeFlat: 50,
  nonCodThreshold: 1000,
  nonCodFeeHigh: 30,
  nonCodFeeLow: 15,
} as any;

/** Prices an errand, varying only the distance, which is the fractional term. */
function priceAt(distanceKm: number, overrides: Record<string, unknown> = {}) {
  return defaultPricingStrategy.calculate(
    {
      // Past the size gate on BOTH counts — over 12 units and at least ₱1,000 —
      // so these cases exercise ROUNDING with a handling fee present rather
      // than accidentally testing the gate. FLAT keeps the fee at ₱50 whatever
      // the basket, so the arithmetic below is unaffected by the amount.
      estimatedCost: 1500,
      itemUnits: 20,
      tip: 0,
      storeCount: 1,
      distanceKm,
      isCod: true,
      categoryModes: ["FLAT"],
      ...overrides,
    } as any,
    RATE_CONFIG
  );
}

describe("the delivery fee is charged in whole pesos", () => {
  it("rounds a half peso up", () => {
    // base 67 + flat handling 50 + 2.55 excess km x 10 = 142.50
    const { deliveryFee } = priceAt(4.05);
    expect(deliveryFee).toBe(143);
  });

  it("rounds a tenth of a peso down", () => {
    // base 67 + flat handling 50 + 2.51 excess km x 10 = 142.10
    const { deliveryFee } = priceAt(4.01);
    expect(deliveryFee).toBe(142);
  });

  it("leaves a fare that is already whole alone", () => {
    const { deliveryFee } = priceAt(4.0);
    expect(deliveryFee).toBe(142);
  });

  it("is always an integer, at every distance", () => {
    for (let km = 0; km <= 30; km += 0.07) {
      const { deliveryFee } = priceAt(km);
      expect(Number.isInteger(deliveryFee)).toBe(true);
    }
  });

  it("rounds the total, not each part", () => {
    // Handling at 10% of 1234 is 123.40 and the distance leg is 0.40, each of
    // which rounds to zero centavos on its own but to a whole peso together.
    const breakdown = defaultPricingStrategy.calculate(
      { estimatedCost: 1234, itemUnits: 20, tip: 0, storeCount: 1, distanceKm: 2.04, isCod: true, categoryModes: ["PERCENT"] } as any,
      RATE_CONFIG
    );
    // 67 + 123.40 + 5.40 = 195.80 -> 196, not 67 + 123 + 5 = 195.
    expect(breakdown.deliveryFee).toBe(196);
  });
});

describe("the breakdown still adds up to the fare", () => {
  const sumOf = (b: any) =>
    Math.round((b.baseFee + b.distanceFee + b.multiStoreFee + b.groceryFee + b.nonCodFee) * 100) / 100;

  it("reconciles at every distance", () => {
    for (let km = 0; km <= 30; km += 0.13) {
      const b = priceAt(km);
      expect(sumOf(b)).toBe(b.deliveryFee);
    }
  });

  it("reconciles with a percentage handling fee and multiple stores", () => {
    for (let km = 0; km <= 20; km += 0.17) {
      const b = defaultPricingStrategy.calculate(
        { estimatedCost: 4321, tip: 0, storeCount: 3, distanceKm: km, isCod: false, categoryModes: ["PERCENT"] } as any,
        RATE_CONFIG
      );
      expect(sumOf(b)).toBe(b.deliveryFee);
    }
  });

  it("keeps every configured component exactly as the owner set it", () => {
    const b = priceAt(4.05);
    expect(b.baseFee).toBe(67);
    expect(b.groceryFee).toBe(50);
    expect(b.multiStoreFee).toBe(0);
    // The rounding lands here, on the one component that is already an estimate.
    expect(b.distanceFee).toBe(26);
  });

  it("never drives the distance fee negative when rounding down", () => {
    // A fractional handling fee with no distance leg at all: rounding down must
    // not be absorbed by a component that is zero.
    const b = defaultPricingStrategy.calculate(
      { estimatedCost: 1234, itemUnits: 20, tip: 0, storeCount: 1, distanceKm: 0, isCod: true, categoryModes: ["PERCENT"] } as any,
      RATE_CONFIG
    );
    expect(b.distanceFee).toBe(0);
    expect(b.deliveryFee).toBe(190); // 67 + 123.40 = 190.40 -> 190
  });
});

describe("what is NOT rounded", () => {
  it("leaves item money to the centavo", () => {
    // A receipt reads 994.50; rounding the customer's own spend would be wrong.
    const b = priceAt(4.05, { estimatedCost: 994.5 });
    expect(b.totalCost).toBe(994.5 + b.deliveryFee);
  });

  it("leaves the tip to the centavo", () => {
    const b = priceAt(4.0, { estimatedCost: 100, tip: 12.75 });
    expect(b.totalCost).toBe(100 + b.deliveryFee + 12.75);
  });
});
