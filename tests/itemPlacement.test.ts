import { beforeEach, describe, expect, it, vi } from "vitest";
import { itemNameKey } from "../src/services/patterns/itemNameKey.js";

/**
 * The feature this covers: stage 3 suggesting WHERE an item is bought, learning
 * from what dispatchers have already decided rather than only predicting from
 * the name.
 *
 * The important property is precedence. A dispatcher who filed "Lozartan" under
 * Mercury Drug last week is remembering; a model reading the same string is
 * guessing from spelling. Learned must beat modelled, and a learned answer that
 * past dispatchers disagreed about must say so rather than presenting a 51%
 * majority as settled.
 */

const mockFindById = vi.fn();
const mockFindCategories = vi.fn();
const mockPabiliFindMany = vi.fn();
const mockInferItems = vi.fn();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { pabiliDetail: { findMany: (...a: unknown[]) => mockPabiliFindMany(...a) } },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
}));
vi.mock("../src/repositories/merchantCategoryRepository.js", () => ({
  merchantCategoryRepository: { findMany: (...a: unknown[]) => mockFindCategories(...a) },
}));
vi.mock("../src/services/categoryInferenceService.js", () => ({
  inferItemCategories: (...a: unknown[]) => mockInferItems(...a),
}));

const { suggestItemPlacements, forgetMemoryCache } = await import(
  "../src/services/itemPlacementService.js"
);

const PHARMACY = { id: 3, name: "Pharmacy & Health" };
const GROCERY = { id: 4, name: "Supermarket & Grocery" };
const BAKERY = { id: 7, name: "Bakery" };

/** Two pinned shops of different kinds, so a category picks one unambiguously. */
const PINS = [
  { id: 101, storeName: "Mercury Drug Poblacion", categoryId: PHARMACY.id },
  { id: 102, storeName: "Puregold Tacurong", categoryId: GROCERY.id },
];

const history = (rows: Array<[string, number | null, string | null]>) =>
  rows.map(([itemName, pinCategoryId, storeCategory]) => ({
    itemName,
    storeCategory,
    pinpoint: pinCategoryId == null ? null : { categoryId: pinCategoryId },
  }));

beforeEach(() => {
  vi.clearAllMocks();
  forgetMemoryCache();
  mockFindById.mockResolvedValue({ id: "err_1", pinpoints: PINS });
  mockFindCategories.mockResolvedValue([PHARMACY, GROCERY, BAKERY]);
  mockPabiliFindMany.mockResolvedValue([]);
  mockInferItems.mockResolvedValue([]);
});

describe("learning from what dispatchers already decided", () => {
  it("uses a past decision instead of asking the model", async () => {
    mockPabiliFindMany.mockResolvedValue(
      history([
        ["Lozartan 50mg", PHARMACY.id, null],
        ["lozartan", PHARMACY.id, null],
      ])
    );

    const [placement] = await suggestItemPlacements("err_1", ["Lozartan"]);

    expect(placement.source).toBe("learned");
    expect(placement.categoryId).toBe(PHARMACY.id);
    expect(placement.learnedFrom).toBe(2);
    // The model is not consulted at all for something already known.
    expect(mockInferItems).not.toHaveBeenCalled();
  });

  it("names one of THIS errand's pinned shops, not just a category", async () => {
    // The whole point of the errand-scoped endpoint: the same item lands on a
    // different pin every order, so a bare category is half an answer.
    mockPabiliFindMany.mockResolvedValue(history([["Biogesic", PHARMACY.id, null]]));

    const [placement] = await suggestItemPlacements("err_1", ["Biogesic 500mg"]);

    expect(placement.pinpointId).toBe(101);
    expect(placement.storeName).toBe("Mercury Drug Poblacion");
  });

  it("says 'once before' rather than asserting a pattern from one decision", async () => {
    // One prior decision agrees with itself 100% of the time, which would
    // otherwise be presented as confidently as forty consistent ones.
    mockPabiliFindMany.mockResolvedValue(history([["Kalamansi", GROCERY.id, null]]));

    const [placement] = await suggestItemPlacements("err_1", ["Kalamansi"]);

    expect(placement.learnedFrom).toBe(1);
    expect(placement.reason).toMatch(/once before/i);
  });

  it("falls back to the model for an item nobody has filed", async () => {
    mockInferItems.mockResolvedValue([
      { available: true, categoryId: GROCERY.id, categoryName: GROCERY.name, confidence: 0.82 },
    ]);

    const [placement] = await suggestItemPlacements("err_1", ["dragon fruit"]);

    expect(placement.source).toBe("model");
    expect(placement.pinpointId).toBe(102);
    expect(mockInferItems).toHaveBeenCalledWith(["dragon fruit"]);
  });

  it("only sends the unknown names to the model", async () => {
    mockPabiliFindMany.mockResolvedValue(history([["Biogesic", PHARMACY.id, null]]));
    mockInferItems.mockResolvedValue([
      { available: true, categoryId: GROCERY.id, categoryName: GROCERY.name, confidence: 0.7 },
    ]);

    await suggestItemPlacements("err_1", ["Biogesic", "something new"]);

    expect(mockInferItems).toHaveBeenCalledWith(["something new"]);
  });

  it("keeps results index-aligned when the two sources are interleaved", async () => {
    // Stage 3 zips these onto its own rows by position, so drift files a
    // pharmacy item under a grocery.
    mockPabiliFindMany.mockResolvedValue(history([["Biogesic", PHARMACY.id, null]]));
    mockInferItems.mockResolvedValue([
      { available: true, categoryId: GROCERY.id, categoryName: GROCERY.name, confidence: 0.7 },
    ]);

    const out = await suggestItemPlacements("err_1", ["unknown thing", "Biogesic"]);

    expect(out[0].name).toBe("unknown thing");
    expect(out[0].source).toBe("model");
    expect(out[1].name).toBe("Biogesic");
    expect(out[1].source).toBe("learned");
  });

  it("prefers the pinned stop's category over the storeCategory text", async () => {
    // The stop is where the rider was actually sent. The text may predate the
    // pinning, or carry a category the dispatcher later corrected.
    mockPabiliFindMany.mockResolvedValue(
      history([["Pandesal", BAKERY.id, "Store 1 - X | Supermarket & Grocery"]])
    );

    const [placement] = await suggestItemPlacements("err_1", ["Pandesal"]);

    expect(placement.categoryId).toBe(BAKERY.id);
  });

  it("reads the category from storeCategory when no stop was attached", async () => {
    mockPabiliFindMany.mockResolvedValue(
      history([["Spanish Bread", null, "Store 2 - Y | Bakery"]])
    );

    const [placement] = await suggestItemPlacements("err_1", ["Spanish Bread"]);

    expect(placement.categoryId).toBe(BAKERY.id);
    expect(placement.source).toBe("learned");
  });
});

describe("learning only from dispatchers, never from the order itself", () => {
  // Both found by running a real order through the console on 2026-09-23:
  // "Biogesic" came back "learned once before" at 100% although nobody had ever
  // filed it. The one row it learned from was the order's own, written by the
  // customer when they placed it.

  it("asks only for rows the dispatcher console filed", async () => {
    await suggestItemPlacements("err_1", ["Biogesic"]);

    // " | " marks the "Store 2 - Julie's | Bakery" form that only stage 3
    // writes. A customer's bare "Bakery" is their guess, not a decision.
    const { where } = mockPabiliFindMany.mock.calls[0][0];
    expect(where.storeCategory).toEqual({ contains: " | " });
  });

  it("does not learn from the errand it is answering for", async () => {
    mockPabiliFindMany.mockResolvedValue([
      { errandId: "err_1", itemName: "Biogesic", storeCategory: "Store 1 - M | Pharmacy & Health", pinpoint: { categoryId: PHARMACY.id } },
    ]);
    mockInferItems.mockResolvedValue([
      { available: true, categoryId: PHARMACY.id, categoryName: PHARMACY.name, confidence: 0.93 },
    ]);

    const [placement] = await suggestItemPlacements("err_1", ["Biogesic"]);

    // Falls through to the model rather than quoting itself back.
    expect(placement.source).toBe("model");
    expect(placement.learnedFrom).toBe(0);
  });

  it("still learns from the same item on OTHER errands", async () => {
    mockPabiliFindMany.mockResolvedValue([
      { errandId: "err_1", itemName: "Biogesic", storeCategory: "Store 1 - M | Pharmacy & Health", pinpoint: { categoryId: PHARMACY.id } },
      { errandId: "err_OTHER", itemName: "Biogesic", storeCategory: "Store 1 - M | Pharmacy & Health", pinpoint: { categoryId: PHARMACY.id } },
    ]);

    const [placement] = await suggestItemPlacements("err_1", ["Biogesic"]);

    expect(placement.source).toBe("learned");
    expect(placement.learnedFrom).toBe(1);
  });
});

describe("refusing to overstate what was learned", () => {
  it("flags a learned answer that past dispatchers disagreed about", async () => {
    mockPabiliFindMany.mockResolvedValue(
      history([
        ["Alcohol", PHARMACY.id, null],
        ["Alcohol", GROCERY.id, null],
        ["Alcohol", GROCERY.id, null],
      ])
    );

    const [placement] = await suggestItemPlacements("err_1", ["Alcohol"]);

    expect(placement.categoryId).toBe(GROCERY.id);
    expect(placement.confidence).toBeCloseTo(0.6667, 3);
    expect(placement.reason).toMatch(/disagree/i);
  });

  it("will not choose between two pinned shops of the same kind", async () => {
    // Category alone cannot separate them, and filing on a coin flip sends a
    // rider to the wrong counter. Same rule stage 3 already applies.
    mockFindById.mockResolvedValue({
      id: "err_1",
      pinpoints: [
        { id: 201, storeName: "Mercury Drug A", categoryId: PHARMACY.id },
        { id: 202, storeName: "Mercury Drug B", categoryId: PHARMACY.id },
      ],
    });
    mockPabiliFindMany.mockResolvedValue(history([["Biogesic", PHARMACY.id, null]]));

    const [placement] = await suggestItemPlacements("err_1", ["Biogesic"]);

    expect(placement.categoryId).toBe(PHARMACY.id);
    expect(placement.pinpointId).toBeNull();
    expect(placement.reason).toMatch(/2 pinned shops match/i);
  });

  it("says so when no pinned shop matches the category at all", async () => {
    mockPabiliFindMany.mockResolvedValue(history([["Pandesal", BAKERY.id, null]]));

    const [placement] = await suggestItemPlacements("err_1", ["Pandesal"]);

    expect(placement.categoryId).toBe(BAKERY.id);
    expect(placement.pinpointId).toBeNull();
    expect(placement.reason).toMatch(/No pinned shop matches/i);
  });

  it("ignores a learned category that has since been deactivated", async () => {
    // Suggesting a category the dispatcher's dropdown no longer offers is
    // worse than falling through to the model.
    mockPabiliFindMany.mockResolvedValue(history([["Widget", 999, null]]));
    mockInferItems.mockResolvedValue([
      { available: true, categoryId: GROCERY.id, categoryName: GROCERY.name, confidence: 0.6 },
    ]);

    const [placement] = await suggestItemPlacements("err_1", ["Widget"]);

    expect(placement.source).toBe("model");
  });

  it("reports nothing rather than guessing when neither source can answer", async () => {
    mockInferItems.mockResolvedValue([{ available: false, reason: "Service unreachable." }]);

    const [placement] = await suggestItemPlacements("err_1", ["zzzz"]);

    expect(placement.source).toBe("none");
    expect(placement.categoryId).toBeNull();
    expect(placement.pinpointId).toBeNull();
  });

  it("404s on an errand that does not exist", async () => {
    mockFindById.mockResolvedValue(null);
    await expect(suggestItemPlacements("nope", ["x"])).rejects.toMatchObject({ status: 404 });
  });
});

describe("the key two dispatchers would agree on", () => {
  it("ignores quantities and packaging", async () => {
    // A memory that only fired on a byte-identical repeat would almost never
    // fire: the same item is typed a dozen ways.
    expect(itemNameKey("Pandesal (10pcs)")).toBe(itemNameKey("pandesal"));
    expect(itemNameKey("Paracetamol 500mg")).toBe(itemNameKey("Paracetamol 250mg"));
    expect(itemNameKey("Tide Powder 1kg")).toBe(itemNameKey("tide powder"));
    expect(itemNameKey("AA Batteries (4pk)")).toBe(itemNameKey("AA batteries"));
  });

  it("keeps words, so two different items never collide", async () => {
    expect(itemNameKey("chicken adobo")).not.toBe(itemNameKey("chicken"));
    expect(itemNameKey("bath soap")).not.toBe(itemNameKey("dish soap"));
  });

  it("never reduces a name to nothing", async () => {
    // An item genuinely called "2x4" still needs a key, and an empty one would
    // collide with every other unparseable name in the table.
    expect(itemNameKey("2x4")).not.toBe("");
    expect(itemNameKey("500mg")).not.toBe("");
  });

  it("handles empty and missing input", async () => {
    expect(itemNameKey("")).toBe("");
    expect(itemNameKey(null)).toBe("");
    expect(itemNameKey(undefined)).toBe("");
  });
});
