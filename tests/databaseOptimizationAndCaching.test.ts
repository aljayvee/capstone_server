import { describe, expect, it, vi, beforeEach } from "vitest";
import { getCachedRateConfig, invalidateRateConfigCache } from "../src/lib/rateConfigCache.js";
import { getCachedMerchantCategories, invalidateMerchantCategoryCache } from "../src/lib/merchantCategoryCache.js";
import { rateConfigRepository } from "../src/repositories/rateConfigRepository.js";
import { merchantCategoryRepository } from "../src/repositories/merchantCategoryRepository.js";
import { errandRepository } from "../src/repositories/errandRepository.js";
import { prisma } from "../src/lib/prisma.js";

vi.mock("../src/repositories/rateConfigRepository.js", () => ({
  rateConfigRepository: {
    findFirst: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/repositories/merchantCategoryRepository.js", () => ({
  merchantCategoryRepository: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errand: {
      findMany: vi.fn(),
    },
  },
}));

describe("Database Optimization & In-Memory Hash Table Caching (Tier 2 & Tier 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRateConfigCache();
    invalidateMerchantCategoryCache();
  });

  describe("RateConfig In-Memory Hash Cache", () => {
    const mockRateConfig = {
      id: 1,
      baseFee: 50,
      perKmRate: 10,
      multiStoreFeePerStore: 30,
      maxAdditionalStores: 2,
      groceryFeeThreshold: 1001,
      groceryFeePercent: 10,
      groceryFeeFlat: 50,
      nonCodThreshold: 3000,
      nonCodFeeHigh: 15,
      nonCodFeeLow: 0,
      updatedAt: new Date(),
    };

    it("fetches from DB on cache miss and caches subsequent reads", async () => {
      (rateConfigRepository.findFirst as any).mockResolvedValueOnce(mockRateConfig);

      // First call (cache miss -> hits DB)
      const first = await getCachedRateConfig();
      expect(first).toEqual(mockRateConfig);
      expect(rateConfigRepository.findFirst).toHaveBeenCalledTimes(1);

      // Second call (cache hit -> skips DB)
      const second = await getCachedRateConfig();
      expect(second).toEqual(mockRateConfig);
      expect(rateConfigRepository.findFirst).toHaveBeenCalledTimes(1);
    });

    it("invalidates cache on mutation so next read fetches fresh DB data", async () => {
      (rateConfigRepository.findFirst as any)
        .mockResolvedValueOnce(mockRateConfig)
        .mockResolvedValueOnce({ ...mockRateConfig, baseFee: 60 });

      // Warm cache
      await getCachedRateConfig();
      expect(rateConfigRepository.findFirst).toHaveBeenCalledTimes(1);

      // Invalidate
      invalidateRateConfigCache();

      // Next read hits DB for fresh data
      const updated = await getCachedRateConfig();
      expect(updated?.baseFee).toBe(60);
      expect(rateConfigRepository.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe("MerchantCategory In-Memory Hash Cache", () => {
    const mockActiveCategories = [
      { id: 1, name: "Fast Food", status: "Active" },
      { id: 2, name: "Pharmacy", status: "Active" },
    ];
    const mockAllCategories = [
      ...mockActiveCategories,
      { id: 3, name: "Retired Shop", status: "Inactive" },
    ];

    it("maintains separate cache keys for active vs all categories", async () => {
      (merchantCategoryRepository.findMany as any)
        .mockResolvedValueOnce(mockActiveCategories)
        .mockResolvedValueOnce(mockAllCategories);

      // First active call (cache miss)
      const active = await getCachedMerchantCategories(false);
      expect(active).toEqual(mockActiveCategories);
      expect(merchantCategoryRepository.findMany).toHaveBeenCalledWith({ includeInactive: false });

      // First all call (cache miss on "ALL" key)
      const all = await getCachedMerchantCategories(true);
      expect(all).toEqual(mockAllCategories);
      expect(merchantCategoryRepository.findMany).toHaveBeenCalledWith({ includeInactive: true });

      // Second calls (cache hits)
      const activeAgain = await getCachedMerchantCategories(false);
      const allAgain = await getCachedMerchantCategories(true);
      expect(activeAgain).toEqual(mockActiveCategories);
      expect(allAgain).toEqual(mockAllCategories);
      expect(merchantCategoryRepository.findMany).toHaveBeenCalledTimes(2);
    });

    it("clears all category keys upon cache invalidation", async () => {
      (merchantCategoryRepository.findMany as any)
        .mockResolvedValueOnce(mockActiveCategories)
        .mockResolvedValueOnce(mockActiveCategories);

      await getCachedMerchantCategories(false);
      expect(merchantCategoryRepository.findMany).toHaveBeenCalledTimes(1);

      invalidateMerchantCategoryCache();

      await getCachedMerchantCategories(false);
      expect(merchantCategoryRepository.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("Bounded Safe Default Pagination in Errand Repository (Tier 4)", () => {
    it("applies take: 50 and skip: 0 by default to findMany()", async () => {
      (prisma.errand.findMany as any).mockResolvedValueOnce([]);

      await errandRepository.findMany();

      expect(prisma.errand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 50,
          skip: 0,
        })
      );
    });

    it("allows custom pagination overrides in findMany({ take: 25, skip: 50 })", async () => {
      (prisma.errand.findMany as any).mockResolvedValueOnce([]);

      await errandRepository.findMany({ take: 25, skip: 50 });

      expect(prisma.errand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 25,
          skip: 50,
        })
      );
    });

    it("applies take: 50 and skip: 0 by default to findManyForDispatcher()", async () => {
      (prisma.errand.findMany as any).mockResolvedValueOnce([]);

      await errandRepository.findManyForDispatcher(99);

      expect(prisma.errand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 50,
          skip: 0,
          where: {
            OR: [
              { status: "AVAILABLE" },
              { status: "CANCELLED" },
              { dispatchLogs: { some: { dispatcherId: 99 } } },
            ],
          },
        })
      );
    });

    it("clamps hostile pagination parameters (negative, non-finite, and excessive take)", async () => {
      (prisma.errand.findMany as any).mockResolvedValue([]);

      // Negative values clamped to min (take: 1, skip: 0)
      await errandRepository.findMany({ take: -5, skip: -10 });
      expect(prisma.errand.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 1, skip: 0 })
      );

      // Excessive take capped to safety maximum of 100
      await errandRepository.findMany({ take: 1000, skip: 10 });
      expect(prisma.errand.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 100, skip: 10 })
      );
    });

    it("allows custom pagination overrides in findManyForDispatcher(id, { take: 10, skip: 20 })", async () => {
      (prisma.errand.findMany as any).mockResolvedValueOnce([]);

      await errandRepository.findManyForDispatcher(99, { take: 10, skip: 20 });

      expect(prisma.errand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
        })
      );
    });
  });
});

