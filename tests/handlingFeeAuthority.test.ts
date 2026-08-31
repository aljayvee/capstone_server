import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHandlingFee } from "../src/services/patterns/pricingStrategy.js";

const ERRAND_ID = "ERR-SPLIT";

let itemRows: { storeCategory: string | null }[] = [];
let pinRows: { category: { handlingFeeMode: string } }[] = [];
let activeCategories: { name: string; handlingFeeMode: string }[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    pabiliItemRequest: { findMany: vi.fn(async () => itemRows) },
    errandPinpoint: { findMany: vi.fn(async () => pinRows) },
    merchantCategory: {
      findMany: vi.fn(async ({ where }: any) => {
        const wanted: string[] = where.name.in;
        return activeCategories
          .filter((c) => wanted.includes(c.name))
          .map((c) => ({ handlingFeeMode: c.handlingFeeMode }));
      }),
    },
  },
}));

const { resolveCategoryModes } = await import("../src/services/patterns/categoryFeeModes.js");

// The live production values.
/**
 * Units enough to clear the size gate on any basket, so these cases exercise
 * WHOSE categories decide the fee rather than whether one applies at all.
 */
const PAST_THE_GATE = 20;

const RATE_CONFIG = {
  groceryFeeFlat: 50,
  groceryFeePercent: 10,
  groceryFeeThreshold: 3000,
} as any;

beforeEach(() => {
  itemRows = [];
  pinRows = [];
  activeCategories = [
    { name: "Fast Food & Restaurant", handlingFeeMode: "FLAT" },
    { name: "Supermarket & Grocery", handlingFeeMode: "PERCENT" },
    { name: "Retail & General Merchandise", handlingFeeMode: "THRESHOLD" },
  ];
});

describe("who decides the handling fee", () => {
  it("keeps the customer's own category when the dispatcher splits to a pricier one", async () => {
    // Customer filed everything under Fast Food & Restaurant.
    itemRows = [
      { storeCategory: "Fast Food & Restaurant" },
      { storeCategory: "Fast Food & Restaurant" },
    ];
    // Dispatcher pinned a fast-food shop AND a grocery.
    pinRows = [
      { category: { handlingFeeMode: "FLAT" } },
      { category: { handlingFeeMode: "PERCENT" } },
    ];

    const modes = await resolveCategoryModes(ERRAND_ID);
    expect(modes).toEqual(["FLAT"]);

    // The bug this closes: a ₱5,000 basket was quoted ₱50 and charged ₱500.
    expect(resolveHandlingFee(5000, PAST_THE_GATE, modes, RATE_CONFIG)).toBe(50);
    expect(resolveHandlingFee(5000, PAST_THE_GATE, ["FLAT", "PERCENT"], RATE_CONFIG)).toBe(500);
  });

  it("still charges percentage when the customer chose the grocery themselves", async () => {
    itemRows = [{ storeCategory: "Supermarket & Grocery" }];
    pinRows = [{ category: { handlingFeeMode: "PERCENT" } }];

    const modes = await resolveCategoryModes(ERRAND_ID);
    expect(modes).toEqual(["PERCENT"]);
    expect(resolveHandlingFee(5000, PAST_THE_GATE, modes, RATE_CONFIG)).toBe(500);
  });

  it("charges the dearer of two categories the customer picked", async () => {
    itemRows = [
      { storeCategory: "Fast Food & Restaurant" },
      { storeCategory: "Supermarket & Grocery" },
    ];
    const modes = await resolveCategoryModes(ERRAND_ID);
    expect(new Set(modes)).toEqual(new Set(["FLAT", "PERCENT"]));
    expect(resolveHandlingFee(5000, PAST_THE_GATE, modes, RATE_CONFIG)).toBe(500);
  });

  it("falls back to the pinned stops when the customer's category was retired", async () => {
    // "test1" exists on live rows but is Inactive, so it resolves to nothing.
    itemRows = [{ storeCategory: "test1" }];
    pinRows = [{ category: { handlingFeeMode: "THRESHOLD" } }];

    expect(await resolveCategoryModes(ERRAND_ID)).toEqual(["THRESHOLD"]);
  });

  it("falls back to the pinned stops when the customer chose no category at all", async () => {
    itemRows = [];
    pinRows = [{ category: { handlingFeeMode: "PERCENT" } }];

    expect(await resolveCategoryModes(ERRAND_ID)).toEqual(["PERCENT"]);
  });

  it("yields nothing when neither source resolves, leaving the caller its default", async () => {
    itemRows = [{ storeCategory: "test1" }];
    pinRows = [];

    const modes = await resolveCategoryModes(ERRAND_ID);
    expect(modes).toEqual([]);
    // resolveHandlingFee treats an empty set as THRESHOLD, which is how these
    // errands have always priced.
    expect(resolveHandlingFee(1500, PAST_THE_GATE, modes, RATE_CONFIG)).toBe(50);
    expect(resolveHandlingFee(5000, PAST_THE_GATE, modes, RATE_CONFIG)).toBe(500);
  });

  it("does not duplicate a mode two items share", async () => {
    itemRows = [
      { storeCategory: "Fast Food & Restaurant" },
      { storeCategory: "Pharmacy & Health" },
    ];
    activeCategories.push({ name: "Pharmacy & Health", handlingFeeMode: "FLAT" });

    expect(await resolveCategoryModes(ERRAND_ID)).toEqual(["FLAT"]);
  });
});

describe("the fee the customer was quoted holds through fulfilment", () => {
  // The reported scenario at every basket size that mattered in the audit.
  const quotedModes = ["FLAT"] as any;

  it.each([
    [250, 3, 0],
    [800, 20, 0],
    [800, 25, 50],
    [1500, 5, 50],
    [3000, 3, 50],
    [5000, 2, 50],
  ])(
    "a ₱%i basket of %i units is charged ₱%i regardless of how the dispatcher splits it",
    (basket, units, expected) => {
      expect(resolveHandlingFee(basket, units, quotedModes, RATE_CONFIG)).toBe(expected);
    }
  );
});
