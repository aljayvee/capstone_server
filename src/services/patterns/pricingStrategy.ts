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
  /**
   * The handling fee the customer already agreed to, if they have agreed to one.
   *
   * Resolved by the caller from `Errand.quotedHandlingFee`. Null or omitted
   * means no ceiling, which is the behaviour that existed before ceilings did.
   */
  quotedHandlingCeiling?: number | null;
  /** Which basket figure this pricing run is working from. */
  handlingEvidence?: HandlingFeeEvidence;
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
  /**
   * The reasoning behind groceryFee. Persisted by errandService.recalculateFee
   * so the fee can account for itself long after it was computed.
   */
  handlingDecision: HandlingFeeDecision;
}

// Swappable at the call site (e.g. a future promo/surge strategy) — this is the
// Strategy pattern applied to the one hardcoded pricing default in the codebase.
export interface PricingStrategy {
  calculate(input: PricingInput, rateConfig: RateConfigValues): PriceBreakdown;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Why a mode charged what it charged.
 *
 * `PERCENT_RELIEVED` is the percentage tier held down by marginal relief; see
 * feeForMode. `CEILING` never appears here — it is applied by decideHandlingFee
 * after every mode has had its say, because it is a fact about what the customer
 * agreed to rather than about any one category.
 */
export type HandlingFeeTier =
  | "UNPRICED"
  | "BELOW_GATE"
  | "NONE"
  | "FLAT"
  | "PERCENT"
  | "PERCENT_RELIEVED"
  | "CEILING";

interface ModeOutcome {
  fee: number;
  tier: HandlingFeeTier;
  /** The relief ceiling that applied, or null where relief has no meaning. */
  reliefCap: number | null;
}

/** What one mode would charge for this basket, and on what reasoning. */
function feeForMode(
  estimatedCost: number,
  mode: HandlingFeeMode,
  rateConfig: RateConfigValues
): ModeOutcome {
  const percentFee = estimatedCost * (rateConfig.groceryFeePercent / 100);

  switch (mode) {
    case "NONE":
      return { fee: 0, tier: "NONE", reliefCap: null };
    case "FLAT":
      return { fee: rateConfig.groceryFeeFlat, tier: "FLAT", reliefCap: null };
    case "PERCENT":
      // No crossover, so nothing to relieve: this mode is a percentage at every
      // basket size by definition.
      return { fee: percentFee, tier: "PERCENT", reliefCap: null };
    case "THRESHOLD":
    default: {
      // Flat below the threshold, percentage at or above it. A small basket is
      // roughly the same work whatever it costs, so it pays one predictable
      // handling fee; a large one ties up proportionally more of the company's
      // cash, so it scales.
      if (estimatedCost < rateConfig.groceryFeeThreshold) {
        return { fee: rateConfig.groceryFeeFlat, tier: "FLAT", reliefCap: null };
      }

      // Marginal relief across the crossover.
      //
      // A bare switch is a cliff: with a ₱1,001 threshold, a ₱1,000 basket paid
      // ₱50 and a ₱1,001 basket paid ₱100.10 — fifty pesos for one peso of
      // groceries. Nobody can be told that with a straight face, and a customer
      // one peso the wrong side of it is being punished for arithmetic they
      // cannot see.
      //
      // So the fee may never climb faster than the basket did. Just past the
      // threshold the flat fee grows peso for peso with the basket, and the
      // plain percentage resumes as soon as it is the cheaper of the two —
      // where 0.1b = flat + (b - reliefFloor), about ₱1,055 on live rates.
      // The result is monotonic and has no step in it.
      const reliefFloor = rateConfig.groceryFeeThreshold - 1;
      const reliefCap = rateConfig.groceryFeeFlat + (estimatedCost - reliefFloor);

      return reliefCap < percentFee
        ? { fee: reliefCap, tier: "PERCENT_RELIEVED", reliefCap }
        : { fee: percentFee, tier: "PERCENT", reliefCap };
    }
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
 * EITHER condition is enough. More than twenty units is a trolley and a long
 * checkout queue whatever it cost; a thousand pesos is a meaningful float of
 * the company's money whether it arrived as one item or thirty. Both are
 * handling work, and neither implies the other.
 *
 * Below both it is a quick pick-up — a couple of meals, a box of paracetamol —
 * and nothing is charged for handling.
 */
/**
 * How far the base fee reaches before the per-km rate starts.
 *
 * Fixed at 2.0 km, matching R_base in docs/errand_pricing_formula.md section 1.
 *
 * This was briefly tightened to 1.5 km on the reasoning that most of Tacurong's
 * downtown sits inside 2 km of everything else, so almost no errand reached the
 * distance fee. That is true and it is not the deciding factor: the published
 * specification says 2.0 km, and the fare a customer can check against the rate
 * card has to be the fare the server charges. Reverted deliberately.
 *
 * Deliberately a code constant rather than a RateConfig column — it is a rule
 * about the shape of the formula, not a price. The owner edits prices; changing
 * where the distance fee starts changes what the base fee MEANS, and that is a
 * specification change. Published to clients via rateConfigService.PRICING_RULES
 * so no surface has to hardcode its own copy.
 */
export const BASE_FEE_DISTANCE_KM = 2.0;

export const HANDLING_ITEM_UNITS_THRESHOLD = 20;
export const HANDLING_AMOUNT_THRESHOLD = 1000;

/**
 * Which basket figure the decision was taken on, strongest evidence first.
 *
 * Mirrors the evidence ladder in categoryRevenueAllocation.buildWeights(): the
 * question "what is this basket actually worth?" has several answers of
 * different quality, and which one was used is part of the answer.
 *
 * A rider's unverified word may lower a bill but must never raise one — that is
 * enforced in decideHandlingFee via the ceiling, not here.
 */
export type HandlingFeeEvidence = "RECEIPT_CONFIRMED" | "RIDER_DECLARED" | "CUSTOMER_ESTIMATE";

export interface HandlingFeeInput {
  estimatedCost: number;
  itemUnits: number;
  categoryModes: HandlingFeeMode[] | undefined;
  rateConfig: RateConfigValues;
  /**
   * The fee the customer already agreed to, if they have agreed to one.
   *
   * The customer is never billed more handling fee than this. `markItemsPurchased`
   * overwrites estimatedCost with the real receipt total AFTER the rider has
   * bought the goods, so there is no moment left in which to ask them to consent
   * to a bigger number — the dispatcher has to secure that agreement out of band,
   * and until they do, this holds the bill where the customer left it.
   */
  quotedCeiling?: number | null;
  evidence?: HandlingFeeEvidence;
}

/** A handling fee, and the complete reasoning behind it. */
export interface HandlingFeeDecision {
  fee: number;
  /** The mode that won. Where several categories apply, the most expensive. */
  mode: HandlingFeeMode;
  tier: HandlingFeeTier;
  basket: number;
  evidence: HandlingFeeEvidence;
  /** What the rules produced before the ceiling was considered. */
  computed: number;
  reliefCap: number | null;
  quotedCeiling: number | null;
  ceilingApplied: boolean;
  decidedAt: Date;
}

/**
 * The handling fee, with its reasoning attached.
 *
 * Returns a record rather than a number because "why ₱50 and not 10%?" is a
 * question the dispatcher, the owner and the customer all end up asking, and
 * until now nothing could answer it — the fee arrived as a bare figure with no
 * account of the mode, the basket, the evidence or the tier behind it.
 *
 * Pure. Every fact it needs is passed in; errandService.recalculateFee is the
 * one caller responsible for gathering them and persisting what comes back.
 */
export function decideHandlingFee(input: HandlingFeeInput): HandlingFeeDecision {
  const { estimatedCost, itemUnits, categoryModes, rateConfig } = input;
  const evidence = input.evidence ?? "CUSTOMER_ESTIMATE";
  const quotedCeiling = input.quotedCeiling ?? null;
  const decidedAt = new Date();

  const base = {
    basket: 0,
    evidence,
    reliefCap: null,
    quotedCeiling,
    ceilingApplied: false,
    decidedAt,
  };

  // Zero means "the customer has not costed their items", not "a small
  // purchase" — a quote taken before then must not carry a handling fee.
  if (estimatedCost <= 0) {
    return { ...base, fee: 0, mode: "NONE", tier: "UNPRICED", computed: 0 };
  }

  // Thresholds are compared against the basket in whole pesos.
  //
  // A basket of 999.99 is a thousand pesos to anyone reading a receipt, and a
  // centavo should not be what decides whether a fee applies. Rounding here
  // matches how the delivery fee itself is charged, so every peso figure in
  // this system means the same thing.
  //
  // Applied to the percentage switch as well, so the two thresholds cannot
  // disagree about what "1,001" means. The percentage is then taken on the same
  // rounded figure, which moves it by at most half a centavo.
  const basket = Math.round(estimatedCost);

  // Nothing at all below the gate, whatever the category.
  const qualifies =
    itemUnits > HANDLING_ITEM_UNITS_THRESHOLD || basket >= HANDLING_AMOUNT_THRESHOLD;
  if (!qualifies) {
    return { ...base, basket, fee: 0, mode: "NONE", tier: "BELOW_GATE", computed: 0 };
  }

  // No resolvable category — a retired or test one, or a quote taken before any
  // category is known. THRESHOLD is what this always did before modes existed.
  //
  // NONE, by contrast, means no handling fee at any basket size. This used to
  // coerce NONE to THRESHOLD above the gate, on the reasoning that a twenty-item
  // Jollibee run for an office is not the two-meal order the exemption was
  // written for. That reasoning still holds on its own terms, and is
  // deliberately reversed: the owner scopes this fee to groceries ("an
  // additional fee will be charged for groceries"), and "groceries only" cannot
  // hold while every exempt category re-prices the moment a basket clears
  // ₱1,000. A category the owner marked exempt is exempt. A large fast-food
  // order still pays base, distance and multi-store fees — the costs it
  // actually creates.
  const declared =
    categoryModes && categoryModes.length > 0 ? categoryModes : (["THRESHOLD"] as const);

  // The most expensive applicable mode wins. Items carry no individual price, so
  // a mixed basket cannot be split between categories — see the note in
  // categoryFeeModes.ts on why this stays keyed to what the customer selected.
  let winner: HandlingFeeMode = declared[0];
  let outcome = feeForMode(basket, winner, rateConfig);
  for (const mode of declared.slice(1)) {
    const candidate = feeForMode(basket, mode, rateConfig);
    if (candidate.fee > outcome.fee) {
      winner = mode;
      outcome = candidate;
    }
  }

  const computed = outcome.fee;

  // The ceiling is the last word, because it is the only input here the customer
  // themselves agreed to.
  if (quotedCeiling !== null && computed > quotedCeiling) {
    return {
      ...base,
      basket,
      fee: quotedCeiling,
      mode: winner,
      tier: "CEILING",
      computed,
      reliefCap: outcome.reliefCap,
      ceilingApplied: true,
    };
  }

  return {
    ...base,
    basket,
    fee: computed,
    mode: winner,
    tier: outcome.tier,
    computed,
    reliefCap: outcome.reliefCap,
  };
}

export function resolveHandlingFee(
  estimatedCost: number,
  itemUnits: number,
  categoryModes: HandlingFeeMode[] | undefined,
  rateConfig: RateConfigValues
): number {
  return decideHandlingFee({ estimatedCost, itemUnits, categoryModes, rateConfig }).fee;
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

    const handlingDecision = decideHandlingFee({
      estimatedCost,
      itemUnits,
      categoryModes: input.categoryModes,
      rateConfig,
      quotedCeiling: input.quotedHandlingCeiling,
      evidence: input.handlingEvidence,
    });
    const groceryFee = handlingDecision.fee;

    // Only applies once a confirmed payment mode isn't COD — currently
    // unreachable in practice (see paymentMethodStrategy.ts's
    // UnavailableStrategy on the client) but modeled now so a future
    // GCash/Bank/Card integration needs no further pricing change.
    const nonCodFee = isCod
      ? 0
      : estimatedCost >= rateConfig.nonCodThreshold
        ? rateConfig.nonCodFeeHigh
        : rateConfig.nonCodFeeLow;

    // The base fee covers the first stretch; the per-km rate starts beyond it,
    // billed in whole started kilometres — a rider who crosses into a new km
    // travels it however little of it the errand needed, so a route 1 metre
    // past the allowance costs the same excess as one 999 metres past it.
    // Matches docs/errand_pricing_formula.md section 2.B.
    const excessKm = Math.ceil(Math.max(0, distanceKm - BASE_FEE_DISTANCE_KM));
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
      // Rounded to match the fee actually charged above, so the record and the
      // bill cannot disagree about the figure they are both describing.
      handlingDecision: { ...handlingDecision, fee: round2(handlingDecision.fee) },
    };
  }
}

export const defaultPricingStrategy: PricingStrategy = new StandardPricingStrategy();
