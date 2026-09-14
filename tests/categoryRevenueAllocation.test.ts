import { describe, expect, it } from "vitest";
import {
  UNCATEGORISED,
  allocate,
  buildWeights,
  primaryCategory,
  round2,
  type CategoryEvidence,
} from "../src/services/patterns/categoryRevenueAllocation.js";

const ACTIVE = new Set([
  "Fast Food & Restaurant",
  "Pharmacy & Health",
  "Supermarket & Grocery",
  "Retail & General Merchandise",
]);

function evidence(partial: Partial<CategoryEvidence> = {}): CategoryEvidence {
  return {
    receipts: [],
    customerItems: [],
    workingItems: [],
    pinnedCategories: [],
    ...partial,
  };
}

function sum(map: ReadonlyMap<string, number>): number {
  return round2([...map.values()].reduce((a, b) => a + b, 0));
}

describe("allocate — reconciliation", () => {
  it("splits a total that does not divide evenly without losing a centavo", () => {
    // The case this function exists for: 1000/3 is 333.333..., and three naive
    // round-to-2 shares come to 999.99. The report would then be a centavo short
    // of its own headline figure.
    const parts = allocate(1000, new Map([["A", 1], ["B", 1], ["C", 1]]));

    expect(sum(parts)).toBe(1000);
    expect([...parts.values()].sort()).toEqual([333.33, 333.33, 333.34]);
  });

  it("reconciles for arbitrary amounts and weights", () => {
    // Deterministic pseudo-random sweep — a property, not an example. If any
    // single case here fails, category columns stop summing to the total.
    let seed = 20260901;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let i = 0; i < 200; i++) {
      const amount = round2(next() * 50000);
      const bucketCount = 1 + Math.floor(next() * 5);
      const weights = new Map<string, number>();
      for (let b = 0; b < bucketCount; b++) {
        weights.set(`C${b}`, round2(next() * 100) + 0.01);
      }

      expect(sum(allocate(amount, weights))).toBe(round2(amount));
    }
  });

  it("is deterministic — the same input twice gives identical output", () => {
    // A report that changes between two refreshes cannot be acted on.
    const weights = new Map([["A", 1], ["B", 1], ["C", 1]]);
    expect([...allocate(1000, weights)]).toEqual([...allocate(1000, weights)]);
  });

  it("gives the spare centavo to the largest remainder, not the largest bucket", () => {
    // 5 centavos across 2:1 weights. A takes 3.333 and B takes 1.667, so the
    // odd centavo goes to B — the SMALLER bucket. This is the whole difference
    // between largest-remainder and "dump the residual in the biggest share":
    // the error stays bounded at one centavo per bucket instead of always
    // landing on the same category and biasing it upward across a whole report.
    const parts = allocate(0.05, new Map([["A", 2], ["B", 1]]));

    expect(sum(parts)).toBe(0.05);
    expect(parts.get("A")).toBe(0.03);
    expect(parts.get("B")).toBe(0.02);
  });

  it("reconciles a negative amount with the sign preserved", () => {
    // Settlement variance runs both ways; a shortage must not become a credit.
    const parts = allocate(-1000, new Map([["A", 1], ["B", 1], ["C", 1]]));

    expect(sum(parts)).toBe(-1000);
    expect([...parts.values()].every((v) => v < 0)).toBe(true);
  });

  it("returns every bucket at zero rather than dropping the key set", () => {
    // A caller folding many errands together must see stable categories, not
    // ones that blink out of existence on a zero-value errand.
    const parts = allocate(0, new Map([["A", 1], ["B", 3]]));

    expect([...parts.keys()].sort()).toEqual(["A", "B"]);
    expect(sum(parts)).toBe(0);
  });

  it("never drops money when the weights are empty or all zero", () => {
    expect(allocate(250, new Map())).toEqual(new Map([[UNCATEGORISED, 250]]));
    expect(allocate(250, new Map([["A", 0]]))).toEqual(new Map([[UNCATEGORISED, 250]]));
  });

  it("gives a single bucket the whole amount", () => {
    expect(allocate(1234.56, new Map([["A", 7]]))).toEqual(new Map([["A", 1234.56]]));
  });
});

describe("buildWeights — tier chain", () => {
  it("prefers receipts even when the customer's own picks disagree", () => {
    // The deliberate inversion of categoryFeeModes' authority order: the fee was
    // computed from what the customer picked, but the MONEY demonstrably passed
    // through the shop that issued the receipt.
    const result = buildWeights(
      evidence({
        receipts: [{ categoryName: "Supermarket & Grocery", amount: 900 }],
        customerItems: [{ categoryName: "Fast Food & Restaurant", quantity: 4 }],
      }),
      ACTIVE
    );

    expect(result.source).toBe("RECEIPTS");
    expect([...result.weights.keys()]).toEqual(["Supermarket & Grocery"]);
  });

  it("falls to the customer's picks when no receipts exist, weighted by quantity", () => {
    const result = buildWeights(
      evidence({
        customerItems: [
          { categoryName: "Pharmacy & Health", quantity: 3 },
          { categoryName: "Fast Food & Restaurant", quantity: 1 },
        ],
      }),
      ACTIVE
    );

    expect(result.source).toBe("CUSTOMER_ITEMS");
    expect(result.weights.get("Pharmacy & Health")).toBe(3);
    expect(result.weights.get("Fast Food & Restaurant")).toBe(1);
  });

  it("still splits when every item subtotal is zero", () => {
    // REGRESSION GUARD — do not delete. PabiliDetail.estimatedSubtotal and
    // .unitPrice are zero on every production row: the CustomerApp posts literal
    // zeros and replaceForErrand does not write those columns at all. Weighting
    // by subtotal would divide by zero on 100% of errands. This proves the
    // quantity-based weights are unaffected by that.
    const result = buildWeights(
      evidence({
        workingItems: [
          { categoryName: "Supermarket & Grocery", quantity: 2 },
          { categoryName: "Pharmacy & Health", quantity: 2 },
        ],
      }),
      ACTIVE
    );

    expect(result.source).toBe("WORKING_ITEMS");
    expect(result.weights.size).toBe(2);
    expect(sum(allocate(500, result.weights))).toBe(500);
  });

  it("walks past every tier that resolves to nothing, conserving the money", () => {
    // A null storeCategory does not vote. Nothing votes here until the pins.
    const result = buildWeights(
      evidence({
        customerItems: [{ categoryName: null, quantity: 2 }],
        workingItems: [{ categoryName: null, quantity: 5 }],
        pinnedCategories: ["Retail & General Merchandise", "Pharmacy & Health"],
      }),
      ACTIVE
    );

    expect(result.source).toBe("PINNED_STOPS");
    // Each distinct stop counts once, so a two-stop errand splits evenly.
    expect(result.weights.get("Retail & General Merchandise")).toBe(1);
    expect(sum(allocate(300, result.weights))).toBe(300);
  });

  it("ignores a category name that is no longer active", () => {
    // Live rows still carry the leftover "test1" and the retired Bills &
    // Payment Centers. Neither may carry attribution authority — the same
    // treatment categoryFeeModes.modesForCategoryNames gives them.
    const result = buildWeights(
      evidence({
        customerItems: [{ categoryName: "test1", quantity: 9 }],
        pinnedCategories: ["Pharmacy & Health"],
      }),
      ACTIVE
    );

    expect(result.source).toBe("PINNED_STOPS");
    expect(result.weights.has("test1")).toBe(false);
  });

  it("puts an errand with no evidence at all in one Uncategorised bucket", () => {
    const result = buildWeights(evidence(), ACTIVE);

    expect(result.source).toBe("UNCATEGORISED");
    expect(allocate(475.25, result.weights)).toEqual(new Map([[UNCATEGORISED, 475.25]]));
  });

  it("ignores a receipt with no amount rather than treating it as a category", () => {
    const result = buildWeights(
      evidence({
        receipts: [{ categoryName: "Supermarket & Grocery", amount: 0 }],
        customerItems: [{ categoryName: "Pharmacy & Health", quantity: 1 }],
      }),
      ACTIVE
    );

    expect(result.source).toBe("CUSTOMER_ITEMS");
  });
});

describe("primaryCategory", () => {
  it("picks the category holding the most money", () => {
    expect(primaryCategory(new Map([["A", 10], ["B", 90]]))).toBe("B");
  });

  it("breaks ties by name so the choice is reproducible", () => {
    expect(primaryCategory(new Map([["B", 50], ["A", 50]]))).toBe("A");
  });

  it("falls back to the residual bucket on empty weights", () => {
    expect(primaryCategory(new Map())).toBe(UNCATEGORISED);
  });
});
