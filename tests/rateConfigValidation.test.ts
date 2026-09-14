import { describe, expect, it } from "vitest";
import { updateRateConfigSchema } from "../src/validators/rateConfigValidators.js";
import { HANDLING_AMOUNT_THRESHOLD } from "../src/services/patterns/pricingStrategy.js";

/**
 * The rate card is not a set of independent numbers.
 *
 * Per-field bounds let any single typo through as long as it was non-negative,
 * and the two relationships below are the whole meaning of the pairs they
 * govern. This is the last thing standing between an owner's slip and every
 * customer's bill.
 */

// The live rate_configs row.
const VALID = {
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

const parse = (overrides: Partial<typeof VALID> = {}) =>
  updateRateConfigSchema.safeParse({ ...VALID, ...overrides });

describe("the live rate card is accepted", () => {
  it("accepts the owner's actual rules", () => {
    // ₱70 base, ₱30 per extra store, ₱50 or 10% handling, ₱15 below ₱3,000 and
    // ₱50 at or above it.
    expect(parse().success).toBe(true);
  });

  it("still accepts equal non-COD fees", () => {
    // A flat fee either side of the threshold is a legitimate choice, so the
    // guard is >=, not >.
    expect(parse({ nonCodFeeHigh: 15, nonCodFeeLow: 15 }).success).toBe(true);
  });

  it("accepts a threshold sitting exactly on the size gate", () => {
    expect(parse({ groceryFeeThreshold: HANDLING_AMOUNT_THRESHOLD }).success).toBe(true);
  });
});

describe("the non-COD fees cannot be inverted", () => {
  it("rejects a smaller fee on the larger purchases", () => {
    // The two columns are named for WHERE they apply, not their size, so nothing
    // about the names stops them being filled in the wrong order.
    const result = parse({ nonCodFeeHigh: 15, nonCodFeeLow: 50 });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "nonCodFeeHigh");
      expect(issue?.message).toMatch(/cannot be lower/i);
    }
  });

  it("says which field to look at", () => {
    // A message with no path leaves the owner hunting across ten inputs.
    const result = parse({ nonCodFeeHigh: 0, nonCodFeeLow: 99 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "nonCodFeeHigh")).toBe(true);
    }
  });
});

describe("the handling crossover cannot delete the flat tier", () => {
  it("rejects a threshold below the size gate", () => {
    // Nothing is charged for handling until the basket clears the gate. A
    // crossover below it means every qualifying basket is already past it, the
    // flat fee applies to nothing, and the owner has silently deleted a tier
    // they can still see on screen.
    const result = parse({ groceryFeeThreshold: 500 });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "groceryFeeThreshold");
      expect(issue?.message).toContain(String(HANDLING_AMOUNT_THRESHOLD));
    }
  });

  it("rejects zero, which would make every basket pay the percentage", () => {
    expect(parse({ groceryFeeThreshold: 0 }).success).toBe(false);
  });
});

describe("per-field bounds still hold", () => {
  it("rejects a negative fee", () => {
    expect(parse({ baseFee: -1 }).success).toBe(false);
  });

  it("rejects a percentage above 100", () => {
    expect(parse({ groceryFeePercent: 101 }).success).toBe(false);
  });

  it("rejects a fractional store count", () => {
    expect(parse({ maxAdditionalStores: 1.5 }).success).toBe(false);
  });
});
