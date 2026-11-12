import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stores a customer picks in the app's "Location" step (2026-10-08). They become
 * the errand's first pins, written with the errand itself, so the dispatcher
 * finds them pinned in Stage 1; the items are filed under them by number, while
 * the customer's own request keeps the category name the fee is decided from.
 */

const area = vi.hoisted(() => ({ inside: true }));
const guard = vi.hoisted(() => ({ blocked: new Set<string>() }));

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    create: vi.fn(async (data: Record<string, unknown>) => ({ id: "e1", customerId: data.customerId, pabiliDetails: [] })),
    findById: vi.fn(async () => ({ id: "e1", customerId: 9, pabiliDetails: [], pinpoints: [{ id: 1 }] })),
  },
  dispatchLogRepository: {},
}));
vi.mock("../src/repositories/rateConfigRepository.js", () => ({
  rateConfigRepository: { findFirst: vi.fn(async () => null) },
}));
vi.mock("../src/repositories/customerTransactionRepository.js", () => ({
  customerTransactionRepository: { create: vi.fn(async () => ({})) },
}));
vi.mock("../src/repositories/pabiliItemRepository.js", () => ({
  pabiliItemRepository: { attachToPinpoints: vi.fn(async () => 2) },
}));
vi.mock("../src/services/storePredictionService.js", () => ({
  forgetStorePredictionMemory: vi.fn(),
}));
vi.mock("../src/services/patterns/categoryFeeModes.js", () => ({
  modesForCategoryNames: vi.fn(async () => []),
  resolveCategoryModes: vi.fn(async () => []),
}));
vi.mock("../src/lib/category/categoryServiceClient.js", () => ({ warmItemCategories: vi.fn() }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrandParties: vi.fn(), emitToCustomer: vi.fn() },
}));
vi.mock("../src/lib/chatAccess.js", () => ({ grantCustomerChat: vi.fn(async () => true), setChatDispatcher: vi.fn() }));
vi.mock("../src/lib/riderWatch.js", () => ({
  grantRiderWatch: vi.fn(async () => false),
  isWatchable: () => false,
  scheduleRiderWatchReconcile: vi.fn(),
}));
vi.mock("../src/lib/serviceArea.js", () => ({
  isServiceAreaConfigured: () => true,
  isWithinServiceArea: () => area.inside,
  isWithinServiceBuffer: () => area.inside,
  // One zone throughout: these tests are about the stores, not the zones (2026-11-09).
  detectServiceZone: () => (area.inside ? "TACURONG" : null),
  validateIntraZone: () => ({ valid: true, zone: "TACURONG" }),
}));
vi.mock("../src/services/storeLocationGuard.js", () => ({
  checkStoreLocation: vi.fn(async (point: { latitude: number }) =>
    guard.blocked.has(String(point.latitude))
      ? { status: "blocked", message: "This spot is off every road a rider can take." }
      : { status: "inside", message: "" }
  ),
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    merchantCategory: {
      findMany: vi.fn(async () => [
        { id: 3, name: "Pharmacy" },
        { id: 5, name: "Fast Food" },
      ]),
    },
    verifiedPlace: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "place-uuid" ? { id: "place-uuid", categoryId: 5 } : null
      ),
    },
  },
}));

import { createErrandSchema } from "../src/validators/errandValidators.js";
import { errandRepository } from "../src/repositories/errandRepository.js";
import { pabiliItemRepository } from "../src/repositories/pabiliItemRepository.js";
import { createErrand, customerStoreFiling } from "../src/services/errandService.js";
import { createErrand as createErrandHandler } from "../src/controllers/errandController.js";

const MERCURY = { name: "Mercury Drug Tacurong", latitude: 6.69, longitude: 124.68, categoryId: 3 };
const JOLLIBEE = { name: "Jollibee", latitude: 6.691, longitude: 124.681, placeId: "place-uuid", categoryId: 3 };

const order = (overrides: Record<string, unknown> = {}) =>
  createErrandSchema.parse({
    deliveryAddress: "Purok 5, Tacurong",
    stores: [MERCURY, JOLLIBEE],
    pabiliItems: [
      { itemName: "Biogesic", storeCategory: "Pharmacy", quantity: 2, storeIndex: 0 },
      { itemName: "Chickenjoy", storeCategory: "Fast Food", quantity: 1, storeIndex: 1 },
    ],
    ...overrides,
  });

const created = () => vi.mocked(errandRepository.create).mock.calls[0][0] as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  area.inside = true;
  guard.blocked = new Set();
});

describe("picked stores on a new errand", () => {
  it("are pinned in the same write as the errand, in the customer's order", async () => {
    await createErrand(9, order());
    expect(created().pinpoints.create).toEqual([
      { sequence: 0, storeName: "Mercury Drug Tacurong", latitude: 6.69, longitude: 124.68, categoryId: 3, placeId: null },
      { sequence: 1, storeName: "Jollibee", latitude: 6.691, longitude: 124.681, categoryId: 5, placeId: "place-uuid" },
    ]);
    expect(created().storeCount).toBe(2);
  });

  it("take a Location Stores row's own category over the app's", async () => {
    await createErrand(9, order());
    // JOLLIBEE was sent with Pharmacy (3); its catalogue row says Fast Food (5).
    expect(created().pinpoints.create[1].categoryId).toBe(5);
  });

  it("file the working copy by stop number and keep the customer's category on the request", async () => {
    await createErrand(9, order());
    expect(created().pabiliDetails.create.map((r: any) => r.storeCategory)).toEqual([
      "Store 1 - Mercury Drug Tacurong | Pharmacy",
      "Store 2 - Jollibee | Fast Food",
    ]);
    expect(created().pabiliItemRequests.create.map((r: any) => r.storeCategory)).toEqual(["Pharmacy", "Fast Food"]);
    expect(pabiliItemRepository.attachToPinpoints).toHaveBeenCalledWith("e1");
  });

  it("drop a category that is not active rather than pin an unknown one", async () => {
    await createErrand(9, order({ stores: [{ ...MERCURY, categoryId: 99 }], pabiliItems: [] }));
    expect(created().pinpoints.create[0].categoryId).toBeNull();
  });

  it("cut a long Google name to what a pin holds", async () => {
    await createErrand(9, order({ stores: [{ ...MERCURY, name: "M".repeat(120) }], pabiliItems: [] }));
    expect(created().pinpoints.create[0].storeName).toHaveLength(60);
  });

  it("refuse the order before anything is written when a store is unreachable", async () => {
    guard.blocked.add("6.69");
    await expect(createErrand(9, order())).rejects.toMatchObject({ status: 422 });
    expect(errandRepository.create).not.toHaveBeenCalled();
  });

  it("leave an order without picked stores exactly as before", async () => {
    await createErrand(9, order({ stores: undefined, storeCount: 1 }));
    expect(created().pinpoints).toBeUndefined();
    expect(created().pabiliDetails.create.map((r: any) => r.storeCategory)).toEqual(["Pharmacy", "Fast Food"]);
    expect(pabiliItemRepository.attachToPinpoints).not.toHaveBeenCalled();
  });
});

describe("the picked-stores request", () => {
  it("refuses a store outside the city", () => {
    area.inside = false;
    expect(() => order({ deliveryLatitude: undefined })).toThrow(/outside all supported service areas/);
  });

  it("refuses an item filed under a store that was not picked", () => {
    expect(() =>
      order({ stores: [MERCURY], pabiliItems: [{ itemName: "Coke", storeCategory: "Pharmacy", storeIndex: 1 }] })
    ).toThrow(/not picked/);
  });

  it("refuses a store count that disagrees with the stores", () => {
    expect(() => order({ storeCount: 3 })).toThrow(/storeCount/);
  });

  it("refuses one Location Stores row picked twice", () => {
    expect(() => order({ stores: [JOLLIBEE, { ...JOLLIBEE, name: "Jollibee again" }] })).toThrow(/picked twice/);
  });
});

describe("the store filing", () => {
  const pins = [{ storeName: "Rose Pharmacy", latitude: 0, longitude: 0, placeId: null, categoryId: null, categoryName: null }];
  it("keeps the customer's category when the store has none", () => {
    expect(customerStoreFiling(pins, 0, "Pharmacy")).toBe("Store 1 - Rose Pharmacy | Pharmacy");
    expect(customerStoreFiling(pins, 0, null)).toBe("Store 1 - Rose Pharmacy");
  });
  it("leaves an item with no store as it came", () => {
    expect(customerStoreFiling(pins, undefined, "Pharmacy")).toBe("Pharmacy");
  });
});

describe("who an order belongs to", () => {
  async function place(user: { id: number; role: string }, body: Record<string, unknown>) {
    const next = vi.fn();
    const res = { status: vi.fn(() => res), json: vi.fn() };
    createErrandHandler({ user, body } as never, res as never, next);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { next, res };
  }

  it("is always the customer who places it, whatever customerId the body names", async () => {
    await place({ id: 9, role: "CUSTOMER" }, { deliveryAddress: "Purok 5", customerId: 5 });
    expect(created().customerId).toBe(9);
  });

  it("is never a dispatcher's or rider's own id", async () => {
    const dispatcher = await place({ id: 9, role: "DISPATCHER" }, { deliveryAddress: "Purok 5" });
    const rider = await place({ id: 9, role: "RIDER" }, { deliveryAddress: "Purok 5", customerId: 5 });
    expect(dispatcher.next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(rider.next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(errandRepository.create).not.toHaveBeenCalled();
  });

  it("is named by the owner's tooling, which must say whose it is", async () => {
    const named = await place({ id: 1, role: "OWNER" }, { deliveryAddress: "Purok 5", customerId: 5 });
    expect(created().customerId).toBe(5);
    expect(named.next).not.toHaveBeenCalled();
    vi.clearAllMocks();
    const unnamed = await place({ id: 1, role: "OWNER" }, { deliveryAddress: "Purok 5" });
    expect(unnamed.next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});
