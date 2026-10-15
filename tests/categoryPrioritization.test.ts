import { describe, expect, it, vi, beforeEach } from "vitest";
import { listMerchantCategories } from "../src/services/merchantCategoryService.js";
import { merchantCategoryRepository } from "../src/repositories/merchantCategoryRepository.js";
import { prisma } from "../src/lib/prisma.js";

vi.mock("../src/repositories/merchantCategoryRepository.js", () => ({
  merchantCategoryRepository: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errandPinpoint: {
      findMany: vi.fn(),
    },
  },
}));

describe("Merchant Category Prioritization & Hierarchy", () => {
  const sampleCategories = [
    { id: 1, name: "Fast Food", status: "Active", _count: { places: 5 } },
    { id: 2, name: "Pharmacy", status: "Active", _count: { places: 6 } },
    { id: 3, name: "Supermarket & Grocery", status: "Active", _count: { places: 8 } },
    { id: 4, name: "Retail & General Merchandise", status: "Active", _count: { places: 3 } },
    { id: 5, name: "Bakery", status: "Active", _count: { places: 4 } },
    { id: 6, name: "Convenience Store", status: "Active", _count: { places: 4 } },
    { id: 7, name: "Restaurant", status: "Active", _count: { places: 3 } },
    { id: 8, name: "Cafe", status: "Active", _count: { places: 4 } },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (merchantCategoryRepository.findMany as any).mockResolvedValue(sampleCategories);
    (prisma.errandPinpoint.findMany as any).mockResolvedValue([]);
  });

  it("prioritizes the top 4 staple categories as recommended for new accounts (cold-start)", async () => {
    const result = await listMerchantCategories(false, null);

    expect(result).toHaveLength(8);
    // Top 4 categories are stamped as recommended
    const top4 = result.slice(0, 4);
    expect(top4.every((c) => c.isRecommended)).toBe(true);

    // Remaining categories are not recommended
    const rest = result.slice(4);
    expect(rest.every((c) => !c.isRecommended)).toBe(true);

    // For a new account with 0 orders, orderedBefore is false
    expect(result.every((c) => !c.orderedBefore)).toBe(true);

    // Default top 4 staple order: Fast Food, Pharmacy, Supermarket, Bakery
    const top4Names = top4.map((c) => c.name);
    expect(top4Names).toContain("Fast Food");
    expect(top4Names).toContain("Pharmacy");
    expect(top4Names).toContain("Supermarket & Grocery");
    expect(top4Names).toContain("Bakery");
  });

  it("dynamically boosts categories the customer has ordered from before to the top", async () => {
    // Simulate customer 99 has placed 3 orders from Bakery and 1 from Cafe
    (prisma.errandPinpoint.findMany as any).mockImplementation((query: any) => {
      if (query?.where?.errand?.customerId === 99) {
        return Promise.resolve([
          { placeId: "p1", place: { categoryId: 5 }, storeName: "Julie's Bakeshop" },
          { placeId: "p1", place: { categoryId: 5 }, storeName: "Julie's Bakeshop" },
          { placeId: "p2", place: { categoryId: 5 }, storeName: "Pan de Manila" },
          { placeId: "p3", place: { categoryId: 8 }, storeName: "Brique Cafe" },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await listMerchantCategories(false, 99);

    // Bakery (id 5, 3 orders) and Cafe (id 8, 1 order) should jump to the top positions
    expect(result[0].name).toBe("Bakery");
    expect(result[0].orderedBefore).toBe(true);
    expect(result[0].orderCount).toBe(3);
    expect(result[0].isRecommended).toBe(true);

    expect(result[1].name).toBe("Cafe");
    expect(result[1].orderedBefore).toBe(true);
    expect(result[1].orderCount).toBe(1);
    expect(result[1].isRecommended).toBe(true);

    // Top 4 are still stamped as recommended
    expect(result.slice(0, 4).every((c) => c.isRecommended)).toBe(true);
  });
});
