export interface RateConfigValues {
  baseFee: number;
  perKmRate: number;
  multiStoreFeePerStore: number;
  maxAdditionalStores: number;
  groceryFeeThreshold: number;
  groceryFeePercent: number;
  groceryFeeFlat: number;
  nonCodThreshold: number;
  nonCodFeeHigh: number;
  nonCodFeeLow: number;
}

// Facts about an errand that affect its price. Distinct from RateConfigValues
// (which is the owner-configured schedule) — this is what's actually known
// about one particular errand at the moment it's priced. Several of these
// facts aren't available until well after creation (see
// errandService.recalculateFee), so callers pass whatever's currently known;
// this strategy never assumes a fact is final.
export interface PricingInput {
  estimatedCost: number;
  tip: number;
  storeCount: number;
  distanceKm: number;
  isCod: boolean;
}

export interface PriceBreakdown {
  deliveryFee: number;
  totalCost: number;
  multiStoreFee: number;
  groceryFee: number;
  nonCodFee: number;
  distanceFee: number;
}

// Swappable at the call site (e.g. a future promo/surge strategy) — this is the
// Strategy pattern applied to the one hardcoded pricing default in the codebase.
export interface PricingStrategy {
  calculate(input: PricingInput, rateConfig: RateConfigValues): PriceBreakdown;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// The single place every fee component is computed (Open/Closed: new fee
// components extend this class's input/output, they never get a second,
// parallel calculation elsewhere) — see errandService.recalculateFee, the
// one caller responsible for gathering the facts this needs and persisting
// the result.
export class StandardPricingStrategy implements PricingStrategy {
  calculate(input: PricingInput, rateConfig: RateConfigValues): PriceBreakdown {
    const { estimatedCost, tip, storeCount, distanceKm, isCod } = input;

    // Every store beyond the first, capped at maxAdditionalStores (matches
    // ErrandFormScreen.tsx's 3-category cap: 1 base store + up to 2 more).
    const additionalStores = Math.min(Math.max(storeCount - 1, 0), rateConfig.maxAdditionalStores);
    const multiStoreFee = additionalStores * rateConfig.multiStoreFeePerStore;

    // A flat cap above the threshold protects large grocery orders from a
    // straight percentage; a percentage below it keeps small orders
    // proportional instead of overpaying a flat fee.
    const groceryFee =
      estimatedCost >= rateConfig.groceryFeeThreshold
        ? rateConfig.groceryFeeFlat
        : estimatedCost * (rateConfig.groceryFeePercent / 100);

    // Only applies once a confirmed payment mode isn't COD — currently
    // unreachable in practice (see paymentMethodStrategy.ts's
    // UnavailableStrategy on the client) but modeled now so a future
    // GCash/Bank/Card integration needs no further pricing change.
    const nonCodFee = isCod
      ? 0
      : estimatedCost >= rateConfig.nonCodThreshold
        ? rateConfig.nonCodFeeHigh
        : rateConfig.nonCodFeeLow;

    // 1. Distance Calculation (First 2.0 km covered by Base Fee)
    const excessKm = Math.max(0, distanceKm - 2.0);
    const distanceFee = excessKm * rateConfig.perKmRate;

    const deliveryFee = rateConfig.baseFee + multiStoreFee + groceryFee + nonCodFee + distanceFee;
    const totalCost = estimatedCost + deliveryFee + tip;

    return {
      deliveryFee: round2(deliveryFee),
      totalCost: round2(totalCost),
      multiStoreFee: round2(multiStoreFee),
      groceryFee: round2(groceryFee),
      nonCodFee: round2(nonCodFee),
      distanceFee: round2(distanceFee),
    };
  }
}

export const defaultPricingStrategy: PricingStrategy = new StandardPricingStrategy();
