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
// Mirrors the Prisma HandlingFeeMode enum. Declared locally rather than imported
// so this module stays a pure function with no dependency on the client.
export type HandlingFeeMode = "THRESHOLD" | "FLAT" | "PERCENT" | "NONE";

export interface PricingInput {
  estimatedCost: number;
  /**
   * Total units on the list — quantities added up, so "Coke x6" counts as six.
   * Reflects what the rider actually carries and queues with.
   */
  itemUnits?: number;
  tip: number;
  storeCount: number;
  distanceKm: number;
  isCod: boolean;
  /**
   * Fee modes of the store categories this errand touches — from the items'
   * `storeCategory` at quote time, from `ErrandPinpoint.categoryId` once pinned.
   *
   * The CALLER resolves these; this strategy stays pure and never reads the
   * database. Omitted or empty falls back to THRESHOLD, which is exactly the
   * behaviour that existed before modes were per-category — so errands whose
   * category cannot be resolved (retired or test categories) price normally
   * instead of throwing.
   */
  categoryModes?: HandlingFeeMode[];
}

export interface PriceBreakdown {
  deliveryFee: number;
  totalCost: number;
  // The five components deliveryFee is the sum of. Returned so callers never
  // have to re-derive one by subtracting the others.
  baseFee: number;
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

/** What one mode would charge for this basket. */
function feeForMode(
  estimatedCost: number,
  mode: HandlingFeeMode,
  rateConfig: RateConfigValues
): number {
  switch (mode) {
    case "NONE":
      return 0;
    case "FLAT":
      return rateConfig.groceryFeeFlat;
    case "PERCENT":
      return estimatedCost * (rateConfig.groceryFeePercent / 100);
    case "THRESHOLD":
    default:
      // Flat below the threshold, percentage at or above it. A small basket is
      // roughly the same work whatever it costs, so it pays one predictable
      // handling fee; a large one ties up proportionally more of the company's
      // cash, so it scales.
      return estimatedCost >= rateConfig.groceryFeeThreshold
        ? estimatedCost * (rateConfig.groceryFeePercent / 100)
        : rateConfig.groceryFeeFlat;
  }
}

/**
 * The purchase handling fee for one errand.
 *
 * An errand can visit up to three stops in three different categories, and there
 * is only ONE basket figure to price — `PabiliItemRequest` carries no per-item
 * price, so the basket cannot be split between stops. So the most expensive
 * applicable mode wins: a grocery run with a pharmacy stop is still substantially
 * a grocery run, and this never under-charges.
 *
 * Taking the maximum of the computed fees rather than ranking the modes is
 * deliberate. It needs no precedence table, and it stays correct at every basket
 * size even though THRESHOLD changes which side it behaves like as the basket
 * grows.
 *
 * A basket of zero is not a small purchase, it is no purchase yet — the customer
 * has not priced their items. Charging the flat fee for it would put a handling
 * charge on every quote made before the items are known.
 */
/**
 * The size at which an errand starts carrying a handling fee at all.
 *
 * BOTH conditions must hold. An errand only counts as real shopping when it is
 * long enough to be a trolley AND valuable enough to be a meaningful float of
 * company cash — either one alone is still a quick pick-up.
 *
 * That is deliberately the generous reading for the customer. Fifteen sachets
 * of shampoo is a long list but barely any money; a ₱2,000 phone case is real
 * money but one thing off a shelf. Neither is the job this fee exists to cover.
 */
/**
 * How far the base fee reaches before the per-km rate starts.
 *
 * Tightened from 2.0 km: most of Tacurong's downtown sits inside 2 km of
 * everything else, so almost no errand ever reached the distance fee and the
 * per-km rate was close to decorative.
 */
export const BASE_FEE_DISTANCE_KM = 1.5;

export const HANDLING_ITEM_UNITS_THRESHOLD = 12;
export const HANDLING_AMOUNT_THRESHOLD = 1000;

export function resolveHandlingFee(
  estimatedCost: number,
  itemUnits: number,
  categoryModes: HandlingFeeMode[] | undefined,
  rateConfig: RateConfigValues
): number {
  if (estimatedCost <= 0) return 0;

  // Nothing at all below the gate, whatever the category.
  const qualifies =
    itemUnits > HANDLING_ITEM_UNITS_THRESHOLD && estimatedCost >= HANDLING_AMOUNT_THRESHOLD;
  if (!qualifies) return 0;

  // No resolvable category — a retired or test one, or a quote taken before any
  // category is known. THRESHOLD is what this always did before modes existed.
  const declared = categoryModes && categoryModes.length > 0 ? categoryModes : ["THRESHOLD" as const];

  // Past the gate, a category marked NONE stops being exempt.
  //
  // Fast Food and Pharmacy carry no handling fee because the ordinary order
  // from them is two meals or one prescription. A twenty-item Jollibee run for
  // an office is not that order, and the exemption was never meant to cover it
  // — so above the gate those categories price like everything else.
  const modes = declared.map((mode) => (mode === "NONE" ? ("THRESHOLD" as const) : mode));

  return Math.max(...modes.map((mode) => feeForMode(estimatedCost, mode, rateConfig)));
}

// The single place every fee component is computed (Open/Closed: new fee
// components extend this class's input/output, they never get a second,
// parallel calculation elsewhere) — see errandService.recalculateFee, the
// one caller responsible for gathering the facts this needs and persisting
// the result.
export class StandardPricingStrategy implements PricingStrategy {
  calculate(input: PricingInput, rateConfig: RateConfigValues): PriceBreakdown {
    const { estimatedCost, tip, storeCount, distanceKm, isCod } = input;
    const itemUnits = input.itemUnits ?? 0;

    // Every store beyond the first, capped at maxAdditionalStores (matches
    // ErrandFormScreen.tsx's 3-category cap: 1 base store + up to 2 more).
    const additionalStores = Math.min(Math.max(storeCount - 1, 0), rateConfig.maxAdditionalStores);
    const multiStoreFee = additionalStores * rateConfig.multiStoreFeePerStore;

    const groceryFee = resolveHandlingFee(estimatedCost, itemUnits, input.categoryModes, rateConfig);

    // Only applies once a confirmed payment mode isn't COD — currently
    // unreachable in practice (see paymentMethodStrategy.ts's
    // UnavailableStrategy on the client) but modeled now so a future
    // GCash/Bank/Card integration needs no further pricing change.
    const nonCodFee = isCod
      ? 0
      : estimatedCost >= rateConfig.nonCodThreshold
        ? rateConfig.nonCodFeeHigh
        : rateConfig.nonCodFeeLow;

    // The base fee covers the first stretch; the per-km rate starts beyond it.
    const excessKm = Math.max(0, distanceKm - BASE_FEE_DISTANCE_KM);
    const exactDistanceFee = excessKm * rateConfig.perKmRate;

    const exactDeliveryFee =
      rateConfig.baseFee + multiStoreFee + groceryFee + nonCodFee + exactDistanceFee;

    // The delivery fee is charged in whole pesos, rounded half up: 80.5 becomes
    // 81, 80.1 becomes 80. Centavos on a fare nobody can pay in centavos are
    // noise — the rider is handed cash at the door.
    //
    // Applied to the TOTAL rather than to each component, because rounding the
    // parts and summing them can land a peso away from rounding the sum: two
    // components of 0.4 round to zero each but to one together.
    const deliveryFee = Math.round(exactDeliveryFee);

    // Which leaves up to half a peso to put somewhere, or the breakdown stops
    // adding up to the fare.
    //
    // It goes on the distance fee by preference: every other component is a
    // figure the owner configured and a customer could check against the
    // published rate card, whereas this one is already an estimate derived from
    // a measured route, so a few centavos of correction change nothing about
    // what it claims.
    //
    // When there is no distance leg — the whole trip inside the 2 km the base
    // fee covers — there is nothing there to absorb it, and a fractional
    // percentage handling fee can still leave a residual. The base fee takes it
    // then, which is also what feeBreakdown derives for such an errand, so the
    // two agree.
    const otherComponents = multiStoreFee + groceryFee + nonCodFee;
    const reconciledDistanceFee = deliveryFee - (rateConfig.baseFee + otherComponents);
    const distanceAbsorbs = exactDistanceFee > 0 && reconciledDistanceFee >= 0;

    const distanceFee = distanceAbsorbs ? reconciledDistanceFee : exactDistanceFee;
    const baseFee = distanceAbsorbs
      ? rateConfig.baseFee
      : deliveryFee - (exactDistanceFee + otherComponents);

    // Item money and tip are real amounts to the centavo — a receipt reads
    // 994.50 — so only the fare is rounded, never the sum of what was spent.
    const totalCost = estimatedCost + deliveryFee + tip;

    return {
      deliveryFee,
      totalCost: round2(totalCost),
      baseFee: round2(baseFee),
      multiStoreFee: round2(multiStoreFee),
      groceryFee: round2(groceryFee),
      nonCodFee: round2(nonCodFee),
      distanceFee: round2(distanceFee),
    };
  }
}

export const defaultPricingStrategy: PricingStrategy = new StandardPricingStrategy();
