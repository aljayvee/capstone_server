import { describe, expect, it } from "vitest";
import { defaultPricingStrategy, resolveHandlingFee } from "../src/services/patterns/pricingStrategy.js";
import { pricingStoreCount } from "../src/services/patterns/pricingStoreCount.js";
import { assignItemsToStops } from "../src/lib/itemStopAssignment.js";
import { splitCommission } from "../src/services/patterns/commissionSplit.js";
import { buildFeeBreakdown } from "../src/services/patterns/feeBreakdown.js";
import { buildRiderEarnings } from "../src/services/patterns/riderEarnings.js";

/**
 * One errand followed from the customer's order, through the dispatcher's
 * corrections, to what the rider is told and paid — using the awkward inputs
 * rather than the tidy ones.
 */

/** Units enough to clear the size gate, so these exercise the mode rules. */
const PAST_THE_GATE = 20;

const RATE = {
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

const price = (over: Record<string, unknown> = {}) =>
  defaultPricingStrategy.calculate(
    {
      estimatedCost: 500,
      tip: 0,
      storeCount: 1,
      distanceKm: 0,
      isCod: true,
      categoryModes: ["FLAT"],
      ...over,
    } as any,
    RATE
  );

/** The five components, summed — must always equal the fare charged. */
const sumOf = (b: any) =>
  Math.round((b.baseFee + b.distanceFee + b.multiStoreFee + b.groceryFee + b.nonCodFee) * 100) / 100;

// ───────────────────────────────────────────────────────────────────────────
// 1. UNUSUAL CUSTOMER ORDERS
// ───────────────────────────────────────────────────────────────────────────

describe("customer orders that are not the tidy case", () => {
  it("charges no handling fee on an empty basket", () => {
    // Submitted before any prices were entered. The fare is still real, because
    // a rider still rides, but there are no goods to handle.
    const b = price({ estimatedCost: 0 });
    expect(b.groceryFee).toBe(0);
    expect(b.deliveryFee).toBe(67);
  });

  it("never charges for more stores than the system allows", () => {
    // A crafted request asking for ten stores. maxAdditionalStores caps it at 2.
    expect(price({ storeCount: 10 }).multiStoreFee).toBe(60);
  });

  it("treats a nonsense store count as a single store", () => {
    expect(pricingStoreCount({ storeCount: 0, pinnedStops: 0 })).toBe(1);
    expect(pricingStoreCount({ storeCount: -3, pinnedStops: 0 })).toBe(1);
    expect(pricingStoreCount({ storeCount: NaN, pinnedStops: 0 })).toBe(1);
  });

  it("switches from flat to percentage exactly at the threshold", () => {
    // The owner's rule: 50 flat below 3000, 10 percent at or above it. The
    // basket is compared in whole pesos, so 2999.99 counts as 3000.
    expect(resolveHandlingFee(2999, PAST_THE_GATE, ["THRESHOLD"], RATE)).toBe(50);
    expect(resolveHandlingFee(2999.99, PAST_THE_GATE, ["THRESHOLD"], RATE)).toBe(300);
    expect(resolveHandlingFee(3000, PAST_THE_GATE, ["THRESHOLD"], RATE)).toBe(300);
  });

  it("charges the dearer mode when the chosen categories disagree", () => {
    // Fast food is FLAT, grocery is PERCENT, and one order picked both.
    expect(resolveHandlingFee(5000, PAST_THE_GATE, ["FLAT", "PERCENT"], RATE)).toBe(500);

    // On a basket that qualifies by VALUE the percentage wins, because 10% of
    // ₱1,000 is already ₱100 against the ₱50 flat.
    expect(resolveHandlingFee(1000, PAST_THE_GATE, ["FLAT", "PERCENT"], RATE)).toBe(100);

    // But on one that qualifies by LENGTH the flat fee wins: twenty-five cheap
    // items is a trolley to push and a queue to stand in, and 10% of ₱200 does
    // not pay for either. Both modes stay reachable, which is the point of
    // taking the dearer rather than assuming one always leads.
    expect(resolveHandlingFee(200, 25, ["FLAT", "PERCENT"], RATE)).toBe(50);
  });

  it("falls back to the threshold rule when no category resolves", () => {
    // A retired category, or one renamed since the order was placed.
    expect(resolveHandlingFee(1500, PAST_THE_GATE, [], RATE)).toBe(50);
    expect(resolveHandlingFee(5000, PAST_THE_GATE, [], RATE)).toBe(500);
  });

  it("prices a very large basket without losing centavos", () => {
    const b = price({ estimatedCost: 99999.99, categoryModes: ["PERCENT"] });
    expect(sumOf(b)).toBe(b.deliveryFee);
    expect(Number.isInteger(b.deliveryFee)).toBe(true);
  });

  it("keeps the fare a whole peso however odd the distance", () => {
    for (const km of [0, 1.999, 2.0001, 3.333, 7.77, 12.121212]) {
      const b = price({ distanceKm: km });
      expect(Number.isInteger(b.deliveryFee)).toBe(true);
      expect(sumOf(b)).toBe(b.deliveryFee);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. DISPATCHER MODIFICATIONS
// ───────────────────────────────────────────────────────────────────────────

const STOPS = [
  { id: 101, sequence: 1, storeName: "Jollibee DT Roundball", categoryName: "Fast Food & Restaurant" },
  { id: 102, sequence: 2, storeName: "Primark Save More", categoryName: "Supermarket & Grocery" },
];

describe("what a dispatcher may change, and what it may cost the customer", () => {
  it("splitting one category across two shops now raises the fare to match", () => {
    // Reversed at Sugo Express's direction: the company no longer absorbs the
    // cost of a dispatcher's split, so pinning more stores than the customer
    // selected bills for the extra one. See pricingStoreCount.ts for the
    // trade-off this re-accepts.
    const quoted = price({ estimatedCost: 5000, storeCount: pricingStoreCount({ storeCount: 1, pinnedStops: 0 }) });
    const split = price({ estimatedCost: 5000, storeCount: pricingStoreCount({ storeCount: 1, pinnedStops: 2 }) });
    expect(split.multiStoreFee).toBe(30);
    expect(split.deliveryFee).toBe(quoted.deliveryFee + 30);
  });

  it("still charges for stores the customer chose themselves", () => {
    expect(price({ storeCount: pricingStoreCount({ storeCount: 3, pinnedStops: 3 }) }).multiStoreFee).toBe(60);
  });

  it("never lets pins undercut what the customer already selected", () => {
    // Dispatcher consolidates three chosen categories into one shop — the
    // customer's own floor still stands, not the smaller pin count.
    expect(price({ storeCount: pricingStoreCount({ storeCount: 3, pinnedStops: 1 }) }).multiStoreFee).toBe(60);
  });

  it("pinning stores does move the distance fee, because a rider rides further", () => {
    const near = price({ distanceKm: 0 });
    const far = price({ distanceKm: 10.76 });
    expect(far.distanceFee).toBeGreaterThan(near.distanceFee);
    expect(far.deliveryFee).toBeGreaterThan(near.deliveryFee);
  });

  it("files each item at the store the dispatcher named", () => {
    expect(
      assignItemsToStops(
        [
          { id: 1, storeCategory: "Store 1 - Jollibee DT Roundball | Fast Food & Restaurant" },
          { id: 2, storeCategory: "Store 2 - Primark Save More | Supermarket & Grocery" },
        ],
        STOPS
      )
    ).toEqual([
      { id: 1, pinpointId: 101 },
      { id: 2, pinpointId: 102 },
    ]);
  });

  it("obeys the named store even when the category on the same label contradicts it", () => {
    // Moved to the grocery with the fast-food tag left behind. Naming the store
    // is the instruction; the tag is a leftover.
    expect(
      assignItemsToStops([{ id: 1, storeCategory: "Store 2 - Primark Save More | Fast Food & Restaurant" }], STOPS)
    ).toEqual([{ id: 1, pinpointId: 102 }]);
  });

  it("still finds the stop after the store has been renamed", () => {
    expect(
      assignItemsToStops([{ id: 1, storeCategory: "Store 2 - whatever it used to be | Supermarket & Grocery" }], STOPS)
    ).toEqual([{ id: 1, pinpointId: 102 }]);
  });

  it("leaves an item unfiled rather than guessing when the store number is stale", () => {
    // "Store 3" on a two-stop errand, left over after a stop was removed. With
    // no category half to fall back on it stays unattached, and the rider sees
    // it as a general item rather than being sent to the wrong shop.
    expect(assignItemsToStops([{ id: 1, storeCategory: "Store 3 - deleted stop" }], STOPS)).toEqual([]);
  });

  it("recovers a stale store number through its category half", () => {
    expect(
      assignItemsToStops([{ id: 1, storeCategory: "Store 3 - deleted stop | Supermarket & Grocery" }], STOPS)
    ).toEqual([{ id: 1, pinpointId: 102 }]);
  });

  it("sends an unlabelled item to the first branch when one chain is pinned twice", () => {
    // Jollibee DT and Jollibee Center are different shops sharing a category.
    // Nothing tells them apart but visit order.
    const twoBranches = [
      { id: 201, sequence: 1, storeName: "Jollibee DT", categoryName: "Fast Food & Restaurant" },
      { id: 202, sequence: 2, storeName: "Jollibee Center", categoryName: "Fast Food & Restaurant" },
    ];
    expect(assignItemsToStops([{ id: 1, storeCategory: "Fast Food & Restaurant" }], twoBranches)).toEqual([
      { id: 1, pinpointId: 201 },
    ]);

    // Unless the dispatcher says which branch.
    expect(
      assignItemsToStops([{ id: 1, storeCategory: "Store 2 - Jollibee Center | Fast Food & Restaurant" }], twoBranches)
    ).toEqual([{ id: 1, pinpointId: 202 }]);
  });

  it("files nothing by category against a bare pin that has none", () => {
    // A pin dropped on a shop outside the catalogue.
    const uncatalogued = [{ id: 301, sequence: 1, storeName: "Aling Nena Store", categoryName: null }];
    expect(assignItemsToStops([{ id: 1, storeCategory: "Fast Food & Restaurant" }], uncatalogued)).toEqual([]);
    // Naming it directly still works.
    expect(assignItemsToStops([{ id: 1, storeCategory: "Store 1 - Aling Nena Store" }], uncatalogued)).toEqual([
      { id: 1, pinpointId: 301 },
    ]);
  });

  it("files an item the dispatcher added that the customer never asked for", () => {
    expect(
      assignItemsToStops([{ id: 99, storeCategory: "Store 2 - Primark Save More | Supermarket & Grocery" }], STOPS)
    ).toEqual([{ id: 99, pinpointId: 102 }]);
  });

  it("does nothing at all before any store is pinned", () => {
    expect(assignItemsToStops([{ id: 1, storeCategory: "Fast Food & Restaurant" }], [])).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. WHAT THE RIDER SEES AND IS PAID
// ───────────────────────────────────────────────────────────────────────────

const errandRow = (over: Record<string, unknown> = {}) => ({
  deliveryFee: 205,
  estimatedCost: 5000,
  tip: 0,
  distanceFee: 88,
  multiStoreFee: 0,
  groceryFee: 50,
  nonCodFee: 0,
  feeCalculatedAt: new Date(),
  routedAt: new Date(),
  ...over,
});

describe("what the rider is shown and paid", () => {
  it("pays 70 percent of the fare and keeps 30 for the business", () => {
    const s = splitCommission({ deliveryFee: 100, tip: 0, itemCost: 0 });
    expect(s.riderShare).toBe(70);
    expect(s.businessShare).toBe(30);
  });

  it("never splits the customer's item money", () => {
    // The headline defect this guards: 5,000 of goods must not inflate a payout.
    const s = splitCommission({ deliveryFee: 100, tip: 0, itemCost: 5000 });
    expect(s.riderShare).toBe(70);
    expect(s.itemCostExcluded).toBe(5000);
  });

  it("hands the rider every centavo of a tip", () => {
    const s = splitCommission({ deliveryFee: 100, tip: 50, itemCost: 0 });
    expect(s.riderShare).toBe(120);
    expect(s.businessShare).toBe(30);
  });

  it("splits an odd fare without losing a centavo", () => {
    const s = splitCommission({ deliveryFee: 205, tip: 0, itemCost: 0 });
    expect(s.riderShare + s.businessShare).toBe(205);
  });

  it("shows a breakdown whose parts add up to what is charged", () => {
    const b = buildFeeBreakdown(errandRow() as any);
    expect(b.fees.baseFee).toBe(67);
    expect(b.fees.subtotal).toBe(205);
    expect(b.grandTotal).toBe(5205);
    expect(b.isFinal).toBe(true);
  });

  it("marks a fare priced before any route as an estimate", () => {
    const b = buildFeeBreakdown(errandRow({ routedAt: null, distanceFee: 0, deliveryFee: 117 }) as any);
    expect(b.isFinal).toBe(false);
  });

  it("prefers a settled payout over recomputing one", () => {
    // The fee moved after the errand closed. The recorded payout must not.
    const e = buildRiderEarnings({
      deliveryFee: 999,
      tip: 0,
      estimatedCost: 0,
      commission: {
        riderShare: 143.5,
        businessShare: 61.5,
        deliveryFee: 205,
        tip: 0,
        commissionRate: 0.7,
        itemCostExcluded: 5000,
      },
    } as any);
    expect(e.riderShare).toBe(143.5);
    expect(e.isFinal).toBe(true);
  });

  it("computes a provisional payout while the errand is still running", () => {
    const e = buildRiderEarnings({ deliveryFee: 205, tip: 0, estimatedCost: 5000, commission: null } as any);
    expect(e.riderShare).toBe(143.5);
    expect(e.itemCostExcluded).toBe(5000);
    expect(e.isFinal).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. WHAT THE UI IS TOLD ABOUT AN EXTRA-CHARGED SPLIT
// ───────────────────────────────────────────────────────────────────────────

describe("explaining why the multi-store surcharge is bigger than checkout predicted", () => {
  it("reports the extra stops, and the fee now reflects them", () => {
    // Customer picked one category; the dispatcher pinned two shops to fulfil
    // it. pricingStoreCount bills for 2, not 1 — see pricingStoreCount.ts for
    // why this errand now pays for the split rather than the company
    // absorbing it, as it once did.
    const billedCount = pricingStoreCount({ storeCount: 1, pinnedStops: 2 });
    const multiStoreFee = price({ storeCount: billedCount }).multiStoreFee;
    const b = buildFeeBreakdown(errandRow({ storeCount: 1, pinnedStops: 2, multiStoreFee }) as any);
    expect(b.extraChargedStores).toBe(1);
    expect(b.fees.multiStoreFee).toBe(30);
  });

  it("reports nothing on an ordinary errand", () => {
    expect(buildFeeBreakdown(errandRow({ storeCount: 2, pinnedStops: 2 }) as any).extraChargedStores).toBe(0);
  });

  it("reports nothing before any store is pinned", () => {
    expect(buildFeeBreakdown(errandRow({ storeCount: 1, pinnedStops: 0 }) as any).extraChargedStores).toBe(0);
  });

  it("never goes negative when a dispatcher consolidates", () => {
    // Customer chose three categories, dispatcher found one shop for all of
    // it. pricingStoreCount still bills for 3 — the customer's own selection
    // is always a floor — but that guarantee lives there, not here: this
    // field only counts stops ABOVE what the customer chose.
    expect(buildFeeBreakdown(errandRow({ storeCount: 3, pinnedStops: 1 }) as any).extraChargedStores).toBe(0);
  });

  it("counts the extra stops on the widest split", () => {
    expect(buildFeeBreakdown(errandRow({ storeCount: 1, pinnedStops: 3 }) as any).extraChargedStores).toBe(2);
  });

  it("stays silent for an errand with no store data at all", () => {
    // Older rows, and slim projections that carry pricing but no stops.
    expect(buildFeeBreakdown(errandRow() as any).extraChargedStores).toBe(0);
  });
});
