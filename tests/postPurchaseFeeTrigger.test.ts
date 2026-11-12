import { describe, expect, it } from "vitest";
import {
  decideHandlingFee,
  StandardPricingStrategy,
  type RateConfigValues,
} from "../src/services/patterns/pricingStrategy.js";

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

describe("Post-Purchase Surcharge Trigger (Unpriced Errand Handling)", () => {
  const strategy = new StandardPricingStrategy();

  it("does not bind a ₱0 ceiling when the errand was booked with an unpriced/zero basket", () => {
    // When the customer confirmed the order with ₱0 items, quotedCeiling was stamped as 0.
    // When the rider enters the real ₱3,500 receipt, the 10% grocery fee MUST trigger (₱350), NOT be clamped to ₱0.
    const decision = decideHandlingFee({
      estimatedCost: 3500,
      itemUnits: 2,
      categoryModes: ["THRESHOLD"],
      rateConfig: RATES,
      quotedCeiling: 0,
      quotedBasket: 0,
    });

    expect(decision.fee).toBe(350);
    expect(decision.tier).toBe("PERCENT");
    expect(decision.ceilingApplied).toBe(false);
  });

  it("still protects the customer with the ceiling when they agreed to a real non-zero basket quote", () => {
    // Customer agreed to a ₱1,000 basket with a ₱50 fee.
    // If receipt comes out to ₱3,500 without prior consent, ceiling of ₱50 holds until escalated.
    const decision = decideHandlingFee({
      estimatedCost: 3500,
      itemUnits: 2,
      categoryModes: ["THRESHOLD"],
      rateConfig: RATES,
      quotedCeiling: 50,
      quotedBasket: 1000,
    });

    expect(decision.fee).toBe(50);
    expect(decision.tier).toBe("CEILING");
    expect(decision.ceilingApplied).toBe(true);
  });

  it("calculates ₱420 total delivery fee for ₱3,500 COD convenience store purchase", () => {
    const breakdown = strategy.calculate(
      {
        estimatedCost: 3500,
        itemUnits: 2,
        tip: 0,
        storeCount: 1,
        distanceKm: 0.222, // within 2.0 km base
        isCod: true,
        categoryModes: ["THRESHOLD"],
        quotedHandlingCeiling: 0,
        quotedHandlingBasket: 0,
      },
      RATES
    );

    expect(breakdown.baseFee).toBe(70);
    expect(breakdown.groceryFee).toBe(350);
    expect(breakdown.nonCodFee).toBe(0);
    expect(breakdown.distanceFee).toBe(0);
    expect(breakdown.deliveryFee).toBe(420);
    expect(breakdown.totalCost).toBe(3920);
  });

  it("triggers ₱50 non-COD surcharge when paying via GCash for ₱3,500 purchase", () => {
    const breakdown = strategy.calculate(
      {
        estimatedCost: 3500,
        itemUnits: 2,
        tip: 0,
        storeCount: 1,
        distanceKm: 0.222,
        isCod: false, // GCash / Non-COD
        categoryModes: ["THRESHOLD"],
        quotedHandlingCeiling: 0,
        quotedHandlingBasket: 0,
      },
      RATES
    );

    expect(breakdown.baseFee).toBe(70);
    expect(breakdown.groceryFee).toBe(350);
    expect(breakdown.nonCodFee).toBe(50); // ₱3,500 >= ₱3,000 threshold
    expect(breakdown.deliveryFee).toBe(470); // 70 + 350 + 50
    expect(breakdown.totalCost).toBe(3970); // 3500 + 470
  });

  it("charges ₱0 grocery fee for fast food category even with ₱3,500 order", () => {
    const breakdown = strategy.calculate(
      {
        estimatedCost: 3500,
        itemUnits: 5,
        tip: 0,
        storeCount: 1,
        distanceKm: 1.5,
        isCod: true,
        categoryModes: ["NONE"], // Fast Food / Restaurant
        quotedHandlingCeiling: 0,
        quotedHandlingBasket: 0,
      },
      RATES
    );

    expect(breakdown.baseFee).toBe(70);
    expect(breakdown.groceryFee).toBe(0);
    expect(breakdown.deliveryFee).toBe(70);
    expect(breakdown.totalCost).toBe(3570);
  });
});
