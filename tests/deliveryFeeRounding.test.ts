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

/** Prices an errand, varying only the distance. */
function priceAt(distanceKm: number, overrides: Record<string, unknown> = {}) {
  return defaultPricingStrategy.calculate(
    {
      // Past the size gate on the AMOUNT (₱1,500 ≥ ₱1,000), so these cases
      // exercise ROUNDING with a handling fee present rather than accidentally
      // testing the gate. FLAT keeps the fee at ₱50 whatever the basket, so the
      // arithmetic below is unaffected by the amount.
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

describe("the distance fee ceils to the next whole started kilometre", () => {
  // A rider who crosses into a new kilometre travels it however little of it
  // the errand actually needed — the fuel and the minutes are the same
  // whether they used 40 metres of that km or all 999. So the excess bills in
  // whole started kilometres, never a fraction. Matches
  // docs/errand_pricing_formula.md section 2.B.
  //
  // Every other fee component is zeroed so nothing but base + distance can
  // contribute — no items means no handling fee, one store means no
  // multi-store fee, COD means no non-COD fee.
  const RATE = {
    baseFee: 70,
    perKmRate: 10,
    multiStoreFeePerStore: 0,
    maxAdditionalStores: 0,
    groceryFeeThreshold: 999999,
    groceryFeePercent: 0,
    groceryFeeFlat: 0,
    nonCodThreshold: 999999,
    nonCodFeeHigh: 0,
    nonCodFeeLow: 0,
  } as any;

  const feeAt = (distanceKm: number) =>
    defaultPricingStrategy.calculate(
      { estimatedCost: 0, itemUnits: 0, tip: 0, storeCount: 1, distanceKm, isCod: true, categoryModes: [] } as any,
      RATE
    ).deliveryFee;

  it.each([
    [1.5, 70], // inside the allowance
    [2.0, 70], // exactly at the allowance
    [2.1, 80], // one metre into the next started km
    [2.9, 80], // still the same started km
    [3.0, 80], // exactly closes the started km
    [3.1, 90], // opens a third km
  ])("bills %skm at ₱%i", (distanceKm, expected) => {
    expect(feeAt(distanceKm)).toBe(expected);
  });

  it("bills two different fractions inside the same started km identically", () => {
    expect(feeAt(2.55)).toBe(feeAt(2.99));
  });

  it("bills one more full km the instant the next km starts", () => {
    expect(feeAt(3.0)).toBe(80);
    expect(feeAt(3.01)).toBe(90);
  });
});

describe("the delivery fee is charged in whole pesos", () => {
  it("is always an integer, at every distance", () => {
    for (let km = 0; km <= 30; km += 0.07) {
      const { deliveryFee } = priceAt(km);
      expect(Number.isInteger(deliveryFee)).toBe(true);
    }
  });

  it("rounds the total, not each part", () => {
    // Two fractional components at once: the handling fee (PERCENT of a
    // basket not a multiple of ₱10) and the distance fee (a fractional
    // perKmRate — an owner can configure ₱10.40/km same as ₱10.00/km; a
    // WHOLE perKmRate alone no longer produces a fractional distance fee
    // under the ceiling formula, so this scenario needs one to keep testing
    // what it claims to test). Rounding each separately first
    // (67 + round(123.4) + round(10.4) = 67 + 123 + 10 = 200) disagrees with
    // rounding the sum once (67 + 123.4 + 10.4 = 200.8 -> 201) — proving the
    // fare is rounded over the total, not component by component.
    const breakdown = defaultPricingStrategy.calculate(
      {
        estimatedCost: 1234,
        itemUnits: 20,
        tip: 0,
        storeCount: 1,
        distanceKm: 2.5,
        isCod: true,
        categoryModes: ["PERCENT"],
      } as any,
      { ...RATE_CONFIG, perKmRate: 10.4 }
    );
    expect(breakdown.deliveryFee).toBe(201);
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

  it("keeps every configured component reconciling exactly, with a fractional rate", () => {
    // Same fractional-perKmRate scenario as "rounds the total, not each
    // part" — the one case in this file where the distance fee still carries
    // real rounding residual under the ceiling formula, since a whole
    // perKmRate (₱10, production's actual rate) makes ceil(excess) ×
    // perKmRate always an integer with nothing left to absorb.
    const b = defaultPricingStrategy.calculate(
      {
        estimatedCost: 1234,
        itemUnits: 20,
        tip: 0,
        storeCount: 1,
        distanceKm: 2.5,
        isCod: true,
        categoryModes: ["PERCENT"],
      } as any,
      { ...RATE_CONFIG, perKmRate: 10.4 }
    );
    expect(b.baseFee).toBe(67);
    expect(b.groceryFee).toBe(123.4);
    expect(b.multiStoreFee).toBe(0);
    // The rounding residual lands here, same preference as always — the one
    // component that is already a measured estimate rather than a configured
    // figure the customer could check against the rate card.
    expect(b.distanceFee).toBe(10.6);
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
