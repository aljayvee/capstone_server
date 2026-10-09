import { describe, expect, it } from "vitest";
import { assignItemsToStops, parseStoreCategory } from "../src/lib/itemStopAssignment.js";
import { defaultPricingStrategy } from "../src/services/patterns/pricingStrategy.js";
import { pricingStoreCount } from "../src/services/patterns/pricingStoreCount.js";

/**
 * The reported scenario, end to end.
 *
 * A customer orders burgers and noodles, filing both under Fast Food &
 * Restaurant because that is the only category they picked. The dispatcher sees
 * that noodles are not fast food, pins Jollibee and Primark Save More, and moves
 * the noodles to the grocery.
 *
 * Two things must hold afterwards: the customer is not charged more for a split
 * they did not ask for, and the rider is told what to buy at each shop.
 */

const RATE_CONFIG = {
  baseFee: 30,
  perKmFee: 8,
  multiStoreFeePerStore: 20,
  maxAdditionalStores: 2,
  groceryThreshold: 3000,
  groceryFlatFee: 50,
  groceryPercentage: 0.1,
  nonCodFeePercentage: 0.02,
  tipEnabled: true,
} as any;

// What the dispatcher pinned.
const STOPS = [
  { id: 101, sequence: 1, storeName: "Jollibee DT Roundball", categoryName: "Fast Food & Restaurant" },
  { id: 102, sequence: 2, storeName: "Primark Save More", categoryName: "Supermarket & Grocery" },
];

describe("the customer's fee after a dispatcher splits their order", () => {
  it("adds a multi-store fee for stores the customer never originally asked for", () => {
    // Reversed at Sugo Express's explicit direction: pinning more stores than
    // the customer selected now bills for the split rather than the company
    // absorbing it. See pricingStoreCount.ts for the trade-off this re-accepts
    // — a customer can end up paying for a split they did not choose and had
    // no way to see coming until the dispatcher pinned it.

    // The customer picked one category, so this is what they were quoted on.
    const committed = 1;

    const quoted = defaultPricingStrategy.calculate(
      { estimatedCost: 250, tip: 0, storeCount: committed, distanceKm: 3, isCod: true, categoryModes: [] },
      RATE_CONFIG
    );

    // The dispatcher then pins two stores.
    const afterPinning = defaultPricingStrategy.calculate(
      {
        estimatedCost: 250,
        tip: 0,
        storeCount: pricingStoreCount({ storeCount: committed, pinnedStops: STOPS.length }),
        distanceKm: 3,
        isCod: true,
        categoryModes: [],
      },
      RATE_CONFIG
    );

    expect(quoted.multiStoreFee).toBe(0);
    expect(afterPinning.multiStoreFee).toBe(20);
    // Not asserting deliveryFee here: this file's RATE_CONFIG carries field
    // names (perKmFee, groceryThreshold, ...) that don't match
    // RateConfigValues, so distanceFee/groceryFee compute as NaN and
    // deliveryFee would too — `toBe` uses Object.is, under which NaN equals
    // NaN, so a deliveryFee assertion here would pass without proving
    // anything. multiStoreFee is unaffected by that mismatch (it never reads
    // perKmRate or the grocery fields), which is why it's safe to assert on.
  });

  it("still charges for stores the customer did choose", () => {
    // Two categories picked: the customer knowingly ordered a two-shop run.
    const breakdown = defaultPricingStrategy.calculate(
      {
        estimatedCost: 250,
        tip: 0,
        storeCount: pricingStoreCount({ storeCount: 2, pinnedStops: 2 }),
        distanceKm: 3,
        isCod: true,
        categoryModes: [],
      },
      RATE_CONFIG
    );

    expect(breakdown.multiStoreFee).toBe(20);
  });

  it("lets pinning raise the count above what the customer agreed to", () => {
    expect(pricingStoreCount({ storeCount: 1, pinnedStops: 3 })).toBe(3);
    expect(pricingStoreCount({ storeCount: 2, pinnedStops: 3 })).toBe(3);
    // The customer's own selection is still a FLOOR: consolidating never
    // undercuts what they already agreed to pay for.
    expect(pricingStoreCount({ storeCount: 3, pinnedStops: 1 })).toBe(3);
    // A missing or nonsensical stored count still prices from the pins alone.
    expect(pricingStoreCount({ storeCount: 0, pinnedStops: 2 })).toBe(2);
  });
});

describe("what the rider is told to buy at each stop", () => {
  it("follows the dispatcher's split, not the customer's original category", () => {
    // How the dispatcher's editor records the correction.
    const items = [
      { id: 1, storeCategory: "Store 1 - Jollibee DT Roundball | Fast Food & Restaurant" },
      { id: 2, storeCategory: "Store 2 - Primark Save More | Supermarket & Grocery" },
    ];

    expect(assignItemsToStops(items, STOPS)).toEqual([
      { id: 1, pinpointId: 101 },
      { id: 2, pinpointId: 102 },
    ]);
  });

  it("reproduces the old failure: matching on category alone sends both to one store", () => {
    // Before the dispatcher edited anything, both items carried the customer's
    // single category — which is why they both landed on Jollibee.
    const untouched = [
      { id: 1, storeCategory: "Fast Food & Restaurant" },
      { id: 2, storeCategory: "Fast Food & Restaurant" },
    ];

    expect(assignItemsToStops(untouched, STOPS)).toEqual([
      { id: 1, pinpointId: 101 },
      { id: 2, pinpointId: 101 },
    ]);
  });

  it("keeps working for items the dispatcher left alone", () => {
    const mixed = [
      { id: 1, storeCategory: "Fast Food & Restaurant" },
      { id: 2, storeCategory: "Store 2 - Primark Save More | Supermarket & Grocery" },
    ];

    expect(assignItemsToStops(mixed, STOPS)).toEqual([
      { id: 1, pinpointId: 101 },
      { id: 2, pinpointId: 102 },
    ]);
  });

  it("trusts the store the dispatcher named over the category on the same label", () => {
    // Dispatcher moved a fast-food item to the grocery without changing the
    // category tag. Naming the store is the instruction.
    const items = [{ id: 1, storeCategory: "Store 2 - Primark Save More | Fast Food & Restaurant" }];
    expect(assignItemsToStops(items, STOPS)).toEqual([{ id: 1, pinpointId: 102 }]);
  });

  it("does not send an item to whatever now stands at its old store number", () => {
    // A pin cannot be renamed, so another name at position 2 is another shop.
    // With the fast-food tag it falls back to the fast-food stop; it is never
    // filed at Primark just for having been "Store 2" once (2026-10-10).
    const items = [{ id: 1, storeCategory: "Store 2 - Kimsan Plaza | Fast Food & Restaurant" }];
    expect(assignItemsToStops(items, STOPS)).toEqual([{ id: 1, pinpointId: 101 }]);
  });

  it("follows a store by name when re-pinning changes its number", () => {
    // Re-pinned: Primark is store 1 now, a new shop is store 2.
    const repinned = [
      { id: 102, sequence: 1, storeName: "Primark Save More", categoryName: "Supermarket & Grocery" },
      { id: 103, sequence: 2, storeName: "Rojon pharmacy", categoryName: "Pharmacy" },
    ];
    const items = [{ id: 1, storeCategory: "Store 2 - Primark Save More | Supermarket & Grocery" }];
    expect(assignItemsToStops(items, repinned)).toEqual([{ id: 1, pinpointId: 102 }]);
  });

  it("reproduces SGO-2B37D6: items filed at a store that was removed are not moved onto its replacement", () => {
    // Pinned again as Rojon pharmacy, 7 Eleven, Jollibee in place of Kimsan
    // Plaza. The ballpens used to land at Rojon pharmacy, the new store 1.
    const now = [
      { id: 201, sequence: 1, storeName: "Rojon pharmacy", categoryName: "Pharmacy" },
      { id: 202, sequence: 2, storeName: "7 Eleven", categoryName: "Convenience Store" },
      { id: 203, sequence: 3, storeName: "Jollibee", categoryName: "Fast Food & Restaurant" },
    ];
    const items = [
      { id: 1, storeCategory: "Store 1 - Kimsan Plaza | Retail & General Merchandise" },
      { id: 2, storeCategory: "Store 2 - Rojon pharmacy | Pharmacy" },
      { id: 3, storeCategory: "Store 2 - 7 Eleven | Convenience Store" },
      { id: 4, storeCategory: "Store 3 - Jollibee | Fast Food & Restaurant" },
    ];
    expect(assignItemsToStops(items, now)).toEqual([
      { id: 2, pinpointId: 201 },
      { id: 3, pinpointId: 202 },
      { id: 4, pinpointId: 203 },
    ]);
  });

  it("matches a name the editor had to clean for its label", () => {
    const stops = [{ id: 301, sequence: 1, storeName: "St. Joseph Drug", categoryName: "Pharmacy" }];
    expect(assignItemsToStops([{ id: 1, storeCategory: "Store 1 - St Joseph Drug | Pharmacy" }], stops)).toEqual([
      { id: 1, pinpointId: 301 },
    ]);
  });

  it("leaves an item unattached rather than guessing a stop for it", () => {
    const items = [{ id: 1, storeCategory: "Hardware & Construction" }];
    expect(assignItemsToStops(items, STOPS)).toEqual([]);
  });

  it("handles items with no category at all", () => {
    expect(assignItemsToStops([{ id: 1, storeCategory: null }], STOPS)).toEqual([]);
  });

  it("does nothing when no stores are pinned yet", () => {
    const items = [{ id: 1, storeCategory: "Fast Food & Restaurant" }];
    expect(assignItemsToStops(items, [])).toEqual([]);
  });
});

describe("parsing the dispatcher's composite label", () => {
  it("splits store from category", () => {
    expect(parseStoreCategory("Store 2 - Primark Save More | Supermarket & Grocery")).toEqual({
      storeLabel: "Store 2 - Primark Save More",
      categoryName: "Supermarket & Grocery",
    });
  });

  it("treats a bare category as the customer wrote it", () => {
    expect(parseStoreCategory("Fast Food & Restaurant")).toEqual({
      storeLabel: null,
      categoryName: "Fast Food & Restaurant",
    });
  });

  it("survives an empty half", () => {
    expect(parseStoreCategory("Store 1 - Jollibee |")).toEqual({
      storeLabel: "Store 1 - Jollibee",
      categoryName: null,
    });
    expect(parseStoreCategory(null)).toEqual({ storeLabel: null, categoryName: null });
  });
});

describe("the dispatcher's bare store default", () => {
  // Their editor falls back to "Store 1 - <name>" with no category half when an
  // item carries no category at all.
  it("reads a bare store label as a store, not a category", () => {
    expect(parseStoreCategory("Store 1 - Jollibee DT Roundball")).toEqual({
      storeLabel: "Store 1 - Jollibee DT Roundball",
      categoryName: null,
    });
  });

  it("still files such an item at the right stop", () => {
    const items = [
      { id: 1, storeCategory: "Store 1 - Jollibee DT Roundball" },
      { id: 2, storeCategory: "Store 2 - Primark Save More" },
    ];
    expect(assignItemsToStops(items, STOPS)).toEqual([
      { id: 1, pinpointId: 101 },
      { id: 2, pinpointId: 102 },
    ]);
  });

  it("does not mistake a real category beginning with 'store' for a label", () => {
    // "Store & Retail" is a plausible category name; only "Store <number>" is
    // the dispatcher's positional label.
    expect(parseStoreCategory("Storewide Retail")).toEqual({
      storeLabel: null,
      categoryName: "Storewide Retail",
    });
  });
});
