import { beforeEach, describe, expect, it, vi } from "vitest";

// Stage 3's Catalog Helper. It searched crawled_merchant_items alone, a table
// nothing ever filled, so every search said "No crawled items found".

vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    crawledMerchantItem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    pabiliDetail: { findMany: vi.fn() },
    merchantCategory: { findFirst: vi.fn() },
    verifiedPlace: { findUnique: vi.fn() },
  },
}));
vi.mock("../src/lib/category/categoryServiceClient.js", () => ({
  searchCommonItems: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { searchCommonItems } from "../src/lib/category/categoryServiceClient.js";
import {
  CatalogInputError,
  catalogueItem,
  retireCatalogItem,
  searchCatalogItems,
  splitStoreCategory,
} from "../src/services/catalogSuggestionService.js";

const db = prisma as unknown as Record<string, { findMany: ReturnType<typeof vi.fn> }>;
const common = searchCommonItems as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  db.crawledMerchantItem.findMany.mockResolvedValue([]);
  db.pabiliDetail.findMany.mockResolvedValue([]);
  common.mockResolvedValue({ results: [], prediction: null });
});

describe("splitStoreCategory", () => {
  it("reads the composite the console writes, and the older bare category", () => {
    expect(splitStoreCategory("Store 2 - Julie's Bakeshop | Bakery")).toEqual({ store: "Julie's Bakeshop", category: "Bakery" });
    expect(splitStoreCategory("Bakery")).toEqual({ store: "", category: "Bakery" });
    expect(splitStoreCategory(null)).toEqual({ store: "", category: "" });
  });
});

describe("searchCatalogItems", () => {
  it("answers from the order history and the common items when no menu was ever crawled", async () => {
    db.pabiliDetail.findMany.mockResolvedValue([
      { itemName: "AA Batteries (4pk)", storeCategory: "Store 1 - Kimsan Plaza | Retail & General Merchandise", createdAt: new Date() },
      { itemName: "AA Batteries (4pk)", storeCategory: "Store 2 - Kimsan Plaza | Retail & General Merchandise", createdAt: new Date() },
    ]);
    common.mockResolvedValue({
      results: [{ name: "AA Battery", category: "Retail & General Merchandise" }],
      prediction: null,
    });

    const found = await searchCatalogItems("batter");
    expect(found.map((s) => [s.source, s.itemName, s.rawStoreName])).toEqual([
      ["history", "AA Batteries (4pk)", "Kimsan Plaza"],
      ["common", "AA Battery", ""],
    ]);
    expect(found[0].timesOrdered).toBe(2); // two errands, one row
    expect(new Set(found.map((s) => s.id)).size).toBe(found.length); // unique React keys
  });

  it("puts a crawled menu first and does not repeat an item the history already names", async () => {
    db.crawledMerchantItem.findMany.mockResolvedValue([
      { id: 7, itemName: "Pandesal", rawStoreName: "Julie's Bakeshop", categoryName: "Bakery", isAvailable: true, verifiedPlaceId: null },
    ]);
    db.pabiliDetail.findMany.mockResolvedValue([
      { itemName: "Pandesal", storeCategory: "Store 1 - Julie's Bakeshop | Bakery", createdAt: new Date() },
    ]);
    common.mockResolvedValue({ results: [{ name: "Pandesal", category: "Bakery" }], prediction: null });

    const found = await searchCatalogItems("pandesal");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 7, source: "crawled" });
  });

  it("offers the model's guess for the text as typed only when nothing matched", async () => {
    common.mockResolvedValue({ results: [], prediction: { name: "Robust Extreme", category: "Pharmacy & Health", confidence: 0.61 } });
    const found = await searchCatalogItems("Robust Extreme");
    expect(found).toEqual([
      expect.objectContaining({ source: "predicted", itemName: "Robust Extreme", categoryName: "Pharmacy & Health", confidence: 0.61 }),
    ]);
  });

  it("still answers from the history when the category service is down", async () => {
    common.mockResolvedValue(null);
    db.pabiliDetail.findMany.mockResolvedValue([
      { itemName: "Fresh Milk", storeCategory: "Supermarket & Grocery", createdAt: new Date() },
    ]);
    const found = await searchCatalogItems("milk");
    expect(found.map((s) => [s.source, s.itemName, s.categoryName])).toEqual([["history", "Fresh Milk", "Supermarket & Grocery"]]);
  });

  it("searches only the place's crawled menu when a place is given", async () => {
    await searchCatalogItems("milk", { placeId: "p1" });
    expect(db.pabiliDetail.findMany).not.toHaveBeenCalled();
    expect(common).not.toHaveBeenCalled();
  });

  it("ignores one-letter searches", async () => {
    expect(await searchCatalogItems("a")).toEqual([]);
  });
});

describe("staff cataloguing", () => {
  const crawled = prisma.crawledMerchantItem as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const category = (prisma as any).merchantCategory.findFirst as ReturnType<typeof vi.fn>;
  const place = (prisma as any).verifiedPlace.findUnique as ReturnType<typeof vi.fn>;
  const input = { itemName: "  Pandesal ", rawStoreName: "Julie's Bakeshop", categoryName: "Bakery" };

  beforeEach(() => {
    category.mockResolvedValue({ name: "Bakery" });
    place.mockResolvedValue(null);
    crawled.findFirst.mockResolvedValue(null);
    crawled.create.mockImplementation(async ({ data }: any) => ({ id: 11, isAvailable: true, verifiedPlaceId: null, ...data }));
  });

  it("writes a STAFF_CATALOGUED row the helper can then find", async () => {
    const { item, created } = await catalogueItem(input);
    expect(created).toBe(true);
    expect(crawled.create.mock.calls[0][0].data).toMatchObject({
      itemName: "Pandesal", // trimmed
      rawStoreName: "Julie's Bakeshop",
      categoryName: "Bakery",
      sourceType: "STAFF_CATALOGUED",
    });
    expect(item).toMatchObject({ id: 11, source: "crawled" });
  });

  it("refreshes an existing row instead of adding a duplicate, and revives a retired one", async () => {
    crawled.findFirst.mockResolvedValue({ id: 5 });
    crawled.update.mockResolvedValue({ id: 5, itemName: "Pandesal", rawStoreName: "Julie's Bakeshop", categoryName: "Bakery", isAvailable: true, verifiedPlaceId: null });
    const { created } = await catalogueItem(input);
    expect(created).toBe(false);
    expect(crawled.create).not.toHaveBeenCalled();
    expect(crawled.update.mock.calls[0][0].data).toMatchObject({ isAvailable: true });
  });

  it("refuses a category an owner has not got active, so owner changes need no code here", async () => {
    category.mockResolvedValue(null);
    await expect(catalogueItem({ ...input, categoryName: "Nope" })).rejects.toBeInstanceOf(CatalogInputError);
    expect(crawled.create).not.toHaveBeenCalled();
  });

  it("refuses a short name, a missing store and a place that does not exist", async () => {
    await expect(catalogueItem({ ...input, itemName: "a" })).rejects.toBeInstanceOf(CatalogInputError);
    await expect(catalogueItem({ ...input, rawStoreName: " " })).rejects.toBeInstanceOf(CatalogInputError);
    await expect(catalogueItem({ ...input, verifiedPlaceId: "gone" })).rejects.toBeInstanceOf(CatalogInputError);
    await expect(catalogueItem({ ...input, itemName: { $gt: "" } })).rejects.toBeInstanceOf(CatalogInputError);
  });

  it("retires by marking unavailable, and reports a missing id", async () => {
    crawled.updateMany.mockResolvedValue({ count: 1 });
    expect(await retireCatalogItem(5)).toBe(true);
    expect(crawled.updateMany).toHaveBeenCalledWith({ where: { id: 5 }, data: { isAvailable: false } });
    crawled.updateMany.mockResolvedValue({ count: 0 });
    expect(await retireCatalogItem(99)).toBe(false);
    expect(await retireCatalogItem(NaN)).toBe(false);
  });
});
