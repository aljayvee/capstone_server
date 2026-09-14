import { describe, expect, it } from "vitest";
import {
  decideHandlingFee,
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

/** Past the size gate by amount, so these cases exercise the tier rules. */
const decide = (
  estimatedCost: number,
  opts: {
    modes?: HandlingFeeMode[];
    units?: number;
    quotedCeiling?: number | null;
    evidence?: "RECEIPT_CONFIRMED" | "RIDER_DECLARED" | "CUSTOMER_ESTIMATE";
  } = {}
) =>
  decideHandlingFee({
    estimatedCost,
    itemUnits: opts.units ?? 20,
    categoryModes: opts.modes ?? ["THRESHOLD"],
    rateConfig: RATES,
    quotedCeiling: opts.quotedCeiling,
    evidence: opts.evidence,
  });

const fee = (estimatedCost: number, opts?: Parameters<typeof decide>[1]) =>
  decide(estimatedCost, opts).fee;

// ───────────────────────────────────────────────────────────────────────────
// MARGINAL RELIEF
// ───────────────────────────────────────────────────────────────────────────

describe("marginal relief across the crossover", () => {
  it.each([
    { basket: 1000, expected: 50, why: "flat — the last peso below the crossover" },
    { basket: 1001, expected: 51, why: "relieved — ₱100.10 would be a ₱50 cliff" },
    { basket: 1010, expected: 60, why: "relieved" },
    { basket: 1050, expected: 100, why: "relieved" },
    { basket: 1055, expected: 105, why: "relieved — the last peso where relief binds" },
    { basket: 1056, expected: 105.6, why: "plain percentage resumes" },
    { basket: 2000, expected: 200, why: "plain percentage, relief long since inert" },
  ])("₱$basket pays ₱$expected ($why)", ({ basket, expected }) => {
    expect(fee(basket)).toBeCloseTo(expected, 6);
  });

  it("never lets the fee rise faster than the basket did", () => {
    // The property the bare `>=` violated, and the reason relief exists: one
    // peso of extra groceries used to cost ₱50 of extra fee. Asserted as a
    // sweep rather than as points, because a cliff can hide between any two
    // examples someone happened to pick.
    for (let basket = 1000; basket < 1200; basket++) {
      const here = fee(basket);
      const next = fee(basket + 1);
      expect(next).toBeGreaterThanOrEqual(here); // monotonic
      expect(next - here).toBeLessThanOrEqual(1 + 1e-9); // never steeper than the basket
    }
  });

  it("labels the tier it actually used", () => {
    expect(decide(1000).tier).toBe("FLAT");
    expect(decide(1001).tier).toBe("PERCENT_RELIEVED");
    expect(decide(2000).tier).toBe("PERCENT");
  });

  it("does not relieve a PERCENT category, which has no crossover to relieve", () => {
    // PERCENT is a percentage at every basket size by definition — there is no
    // step for relief to smooth, so it must not be quietly discounted.
    expect(fee(1001, { modes: ["PERCENT"] })).toBeCloseTo(100.1, 6);
    expect(decide(1001, { modes: ["PERCENT"] }).reliefCap).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE QUOTED CEILING
// ───────────────────────────────────────────────────────────────────────────

describe("the quoted ceiling", () => {
  it("holds the fee at what the customer agreed to", () => {
    // Quoted ₱50 on a ₱1,000 estimate; the receipt rang up at ₱1,200. The
    // rider had already bought the goods by then, so there was no moment left
    // to ask the customer to consent to ₱120.
    const d = decide(1200, { quotedCeiling: 50 });

    expect(d.fee).toBe(50);
    expect(d.tier).toBe("CEILING");
    expect(d.ceilingApplied).toBe(true);
    // The record still carries what the rule alone would have charged, so the
    // owner can see the gap rather than just the held figure.
    expect(d.computed).toBeCloseTo(120, 6);
  });

  it("is a ratchet that only ever falls", () => {
    // A smaller real basket lowers the bill; the ceiling is a cap, not a floor.
    const d = decide(900, { units: 5, quotedCeiling: 50 });

    expect(d.fee).toBe(0); // below the gate entirely
    expect(d.ceilingApplied).toBe(false);
  });

  it("does not bind when the rules land under it", () => {
    const d = decide(1000, { quotedCeiling: 500 });

    expect(d.fee).toBe(50);
    expect(d.tier).toBe("FLAT");
    expect(d.ceilingApplied).toBe(false);
  });

  it("is absent on an errand nobody has quoted yet", () => {
    const d = decide(2000);

    expect(d.quotedCeiling).toBeNull();
    expect(d.ceilingApplied).toBe(false);
    expect(d.fee).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// EVIDENCE
// ───────────────────────────────────────────────────────────────────────────

describe("the evidence ladder", () => {
  it("defaults to the customer's own estimate", () => {
    expect(decide(2000).evidence).toBe("CUSTOMER_ESTIMATE");
  });

  it("records which figure the decision was taken on", () => {
    expect(decide(2000, { evidence: "RECEIPT_CONFIRMED" }).evidence).toBe("RECEIPT_CONFIRMED");
    expect(decide(2000, { evidence: "RIDER_DECLARED" }).evidence).toBe("RIDER_DECLARED");
  });

  it("will not let an unverified rider figure raise the bill past the ceiling", () => {
    // A NO_RECEIPT shop where the rider declared ₱3,000 against a ₱1,000
    // agreement. One person's word must not raise a customer's bill — the
    // ceiling is what enforces that, whatever the evidence claims.
    const d = decide(3000, { quotedCeiling: 50, evidence: "RIDER_DECLARED" });

    expect(d.fee).toBe(50);
    expect(d.ceilingApplied).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE RECORD
// ───────────────────────────────────────────────────────────────────────────

describe("the decision explains itself", () => {
  it("reports the winning mode on a mixed-category errand", () => {
    // A pharmacy stop (NONE) alongside a supermarket stop (THRESHOLD): the
    // charging mode wins, and the record says which one it was.
    const d = decide(2000, { modes: ["NONE", "THRESHOLD"] });

    expect(d.fee).toBe(200);
    expect(d.mode).toBe("THRESHOLD");
  });

  it("distinguishes an unpriced basket from an exempt one", () => {
    // Both charge nothing, and they are not the same fact: one is "not costed
    // yet", the other is "this category never pays".
    expect(decide(0).tier).toBe("UNPRICED");
    expect(decide(2000, { modes: ["NONE"] }).tier).toBe("NONE");
    expect(decide(800, { units: 5 }).tier).toBe("BELOW_GATE");
  });

  it("always carries a basket, a tier and a timestamp", () => {
    const d = decide(1500);

    expect(d.basket).toBe(1500);
    expect(d.tier).toBeTruthy();
    expect(d.decidedAt).toBeInstanceOf(Date);
  });

  it("rounds the basket to whole pesos before deciding anything", () => {
    // A centavo must not decide which tier a customer lands in.
    expect(decide(1000.49).basket).toBe(1000);
    expect(decide(1000.49).tier).toBe("FLAT");
    expect(decide(1000.5).basket).toBe(1001);
    expect(decide(1000.5).tier).toBe("PERCENT_RELIEVED");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE WIRING
//
// The engine above is pure. These cases prove the full pricing path actually
// carries a ceiling in and a decision back out — errandService.recalculateFee
// reads both, and a decision that never reached the breakdown would be a record
// of nothing.
// ───────────────────────────────────────────────────────────────────────────

describe("the strategy carries the decision", () => {
  const price = (estimatedCost: number, quotedHandlingCeiling?: number | null) =>
    new StandardPricingStrategy().calculate(
      {
        estimatedCost,
        itemUnits: 20,
        tip: 0,
        storeCount: 1,
        distanceKm: 0,
        isCod: true,
        categoryModes: ["THRESHOLD"],
        quotedHandlingCeiling,
      },
      RATES
    );

  it("returns the reasoning alongside the fee", () => {
    const b = price(2000);

    expect(b.groceryFee).toBe(200);
    expect(b.handlingDecision.fee).toBe(200);
    expect(b.handlingDecision.tier).toBe("PERCENT");
    expect(b.handlingDecision.basket).toBe(2000);
  });

  it("honours a ceiling passed through the strategy", () => {
    // The case that motivated all of this: quoted ₱50 on a ₱1,000 estimate, the
    // receipt rings up ₱1,200, and the rider has already paid for the goods.
    const b = price(1200, 50);

    expect(b.groceryFee).toBe(50);
    expect(b.handlingDecision.tier).toBe("CEILING");
    expect(b.handlingDecision.computed).toBeCloseTo(120, 6);
  });

  it("keeps the components summing to the delivery fee under a ceiling", () => {
    // A held fee must not leave the breakdown unable to add up — the invariant
    // every persisted fee column depends on.
    const b = price(1200, 50);
    const parts = b.baseFee + b.multiStoreFee + b.groceryFee + b.nonCodFee + b.distanceFee;

    expect(parts).toBeCloseTo(b.deliveryFee, 6);
    expect(b.totalCost).toBeCloseTo(b.deliveryFee + 1200, 6);
  });

  it("prices exactly as before when no ceiling is set", () => {
    // Every errand confirmed before ceilings existed carries null, and must be
    // billed the way it always was.
    expect(price(1200, null).groceryFee).toBe(price(1200).groceryFee);
    expect(price(1200, null).handlingDecision.ceilingApplied).toBe(false);
  });
});
