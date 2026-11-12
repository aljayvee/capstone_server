import { beforeEach, describe, expect, it, vi } from "vitest";

// A category rename must follow every row that stores the category by name,
// and a verified place must be learned without waiting for the night.

const { prisma, repo, trigger, placeRepo } = vi.hoisted(() => {
  const updates: Array<{ model: string; where: any; data: any }> = [];
  const model = (name: string, composite: string[]) => ({
    findMany: vi.fn(async () => composite.map((storeCategory) => ({ storeCategory }))),
    updateMany: vi.fn(async ({ where, data }: any) => {
      updates.push({ model: name, where, data });
      return { count: 1 };
    }),
  });
  return {
    prisma: {
      updates,
      pabiliDetail: model("pabiliDetail", [
        "Store 1 - Julie's Bakeshop | Bakery",
        "Store 2 - Tacurong Bakeshop | Bakery",
      ]),
      pabiliItemRequest: model("pabiliItemRequest", ["Store 1 - Julie's Bakeshop | Bakery"]),
      crawledMerchantItem: model("crawledMerchantItem", []),
      $transaction: vi.fn(async (operations: Array<Promise<any>>) => Promise.all(operations)),
    },
    repo: { findById: vi.fn(), update: vi.fn() },
    trigger: vi.fn(),
    placeRepo: {
      create: vi.fn(async (x: any) => ({ id: "p1", ...x })),
      findById: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findAllForDuplicates: vi.fn(async () => []),
    },
  };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/lib/eventPublisher.js", () => ({ eventPublisher: { publish: vi.fn(), emit: vi.fn() } }));
vi.mock("../src/repositories/merchantCategoryRepository.js", () => ({ merchantCategoryRepository: repo }));
vi.mock("../src/services/categoryRetrainingService.js", () => ({ triggerCategoryAutoLearning: trigger }));
vi.mock("../src/repositories/placeRepository.js", () => ({ placeRepository: placeRepo }));
// Every Location Store is a Google Maps place (2026-10-13): Honesty Bakeshop is one, at its own pin.
vi.mock("../src/lib/places/googlePlaceConfirm.js", () => ({
  PlaceConfirmError: class extends Error {},
  confirmGooglePlace: vi.fn(async () => ({ name: "Honesty Bakeshop", latitude: 6.687803, longitude: 124.678492 })),
}));

import { renameFiledCategory, updateMerchantCategory } from "../src/services/merchantCategoryService.js";
import { PlaceService } from "../src/services/placeService.js";

beforeEach(() => {
  prisma.updates.length = 0;
  trigger.mockClear();
  repo.findById.mockResolvedValue({ id: 5, name: "Bakery", description: "This is a bakery" });
  repo.update.mockImplementation(async (id: number, input: any) => ({ id, name: input.name ?? "Bakery" }));
});

describe("renameFiledCategory", () => {
  it("moves the bare name, the composite text and crawled items, and only the category part", async () => {
    await renameFiledCategory("Bakery", "Breads & Pastries");
    const changes = prisma.updates.map((u) => `${u.model}: ${JSON.stringify(u.where)} -> ${JSON.stringify(u.data)}`);
    expect(changes).toEqual([
      'pabiliDetail: {"storeCategory":"Bakery"} -> {"storeCategory":"Breads & Pastries"}',
      'pabiliItemRequest: {"storeCategory":"Bakery"} -> {"storeCategory":"Breads & Pastries"}',
      'crawledMerchantItem: {"categoryName":"Bakery"} -> {"categoryName":"Breads & Pastries"}',
      // The shop's name keeps its "Bakeshop"; only the text after " | " changes.
      'pabiliDetail: {"storeCategory":"Store 1 - Julie\'s Bakeshop | Bakery"} -> {"storeCategory":"Store 1 - Julie\'s Bakeshop | Breads & Pastries"}',
      'pabiliDetail: {"storeCategory":"Store 2 - Tacurong Bakeshop | Bakery"} -> {"storeCategory":"Store 2 - Tacurong Bakeshop | Breads & Pastries"}',
      'pabiliItemRequest: {"storeCategory":"Store 1 - Julie\'s Bakeshop | Bakery"} -> {"storeCategory":"Store 1 - Julie\'s Bakeshop | Breads & Pastries"}',
    ]);
    expect(prisma.pabiliDetail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeCategory: { endsWith: " | Bakery" } } })
    );
  });

  it("does nothing for an unchanged name", async () => {
    expect(await renameFiledCategory("Bakery", "Bakery")).toBe(0);
    expect(prisma.updates).toHaveLength(0);
  });
});

describe("updateMerchantCategory", () => {
  it("moves the stored rows when the name changes, then retrains", async () => {
    await updateMerchantCategory(5, { name: "Breads & Pastries" } as any);
    expect(prisma.updates.length).toBeGreaterThan(0);
    expect(trigger).toHaveBeenCalledWith({ reason: "updated", categoryId: 5 });
  });

  it("leaves the stored rows alone when only the description changes", async () => {
    await updateMerchantCategory(5, { description: "Bread, cakes and pastries" } as any);
    expect(prisma.updates).toHaveLength(0);
    expect(trigger).toHaveBeenCalledOnce();
  });
});

describe("verified places", () => {
  it("retrains when the owner adds, edits or removes one", async () => {
    const service = new PlaceService(placeRepo as any);
    placeRepo.findById.mockResolvedValue({ id: "p1" });
    // Honesty Bakeshop, inside Tacurong: the service refuses places outside it.
    await service.createPlace({
      name: "Honesty Bakeshop",
      latitude: 6.687803,
      longitude: 124.678492,
      googlePlaceId: "ChIJhonesty01",
    } as any);
    await service.updatePlace("p1", { name: "Honesty Bakeshop Tacurong" } as any);
    await service.deletePlace("p1");
    expect(trigger.mock.calls.map((c) => c[0].reason)).toEqual([
      "verified place created",
      "verified place updated",
      "verified place deleted",
    ]);
  });

  it("learns nothing from a place it refused for being outside every service area", async () => {
    const service = new PlaceService(placeRepo as any);
    // Koronadal, about 20 km south.
    await expect(
      service.createPlace({ name: "Koronadal Bakeshop", latitude: 6.5003, longitude: 124.8469 } as any)
    ).rejects.toThrow(/outside all supported service areas/);
    expect(trigger).not.toHaveBeenCalled();
  });
});
