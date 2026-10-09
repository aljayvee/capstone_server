import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two errandService fixes from 2026-10-09:
 *  - updateItems re-prices. The handling fee's gate counts item units, so a
 *    dispatcher changing quantities could move it, and the quote card the
 *    dispatcher then sent showed the old fee.
 *  - notifyDispatcherChatMessage only for the errand's own customer. Any
 *    signed-in account could push text to any errand's dispatcher.
 */

const { errand, calculate, notifyDispatcherCustomerChat } = vi.hoisted(() => ({
  errand: {} as any,
  calculate: vi.fn(() => ({
    deliveryFee: 120,
    totalCost: 420,
    multiStoreFee: 0,
    groceryFee: 50,
    nonCodFee: 0,
    distanceFee: 20,
    handlingDecision: { tier: "FLAT" },
  })),
  notifyDispatcherCustomerChat: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findById: vi.fn(async () => errand),
    findByIdBasic: vi.fn(async () => errand),
    update: vi.fn(async (_: string, data: object) => ({ ...errand, ...data })),
  },
  dispatchLogRepository: { findLatestByErrandId: vi.fn(async () => ({ dispatcherId: 3 })) },
}));
vi.mock("../src/repositories/pabiliDetailRepository.js", () => ({
  pabiliDetailRepository: { replaceForErrand: vi.fn(async () => undefined) },
}));
vi.mock("../src/repositories/pabiliItemRepository.js", () => ({
  pabiliItemRepository: { attachToPinpoints: vi.fn(async () => 0) },
}));
vi.mock("../src/repositories/customerRepository.js", () => ({
  customerRepository: { findById: vi.fn(async () => null) },
}));
vi.mock("../src/repositories/rateConfigRepository.js", () => ({
  rateConfigRepository: { findFirst: vi.fn(async () => ({ id: 1 })) },
}));
vi.mock("../src/repositories/paymentSelectionRepository.js", () => ({
  paymentSelectionRepository: { findByErrandId: vi.fn(async () => null) },
}));
vi.mock("../src/repositories/customerTransactionRepository.js", () => ({
  customerTransactionRepository: { updateAmountByErrandId: vi.fn(async () => undefined) },
}));
vi.mock("../src/services/routingService.js", () => ({
  routeDistanceKm: vi.fn(async () => ({
    distanceKm: 1,
    result: { distanceMeters: 1000, durationSeconds: 300, encodedGeometry: null, provider: "osrm" },
  })),
}));
vi.mock("../src/services/patterns/pricingStrategy.js", () => ({ defaultPricingStrategy: { calculate } }));
vi.mock("../src/services/patterns/categoryFeeModes.js", () => ({
  resolveCategoryModes: vi.fn(async () => ["THRESHOLD"]),
  modesForCategoryNames: vi.fn(async () => []),
}));
vi.mock("../src/services/patterns/handlingEvidence.js", () => ({
  resolveHandlingEvidence: vi.fn(async () => ({})),
}));
vi.mock("../src/services/notificationService.js", () => ({
  notifyFeeUpdated: vi.fn(async () => undefined),
  notifyDispatcherCustomerChat,
}));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn(), emitToRole: vi.fn(), emitToRider: vi.fn(), emitToCustomer: vi.fn() },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { updateItems, notifyDispatcherChatMessage } = await import("../src/services/errandService.js");
const { errandRepository } = await import("../src/repositories/errandRepository.js");

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(errand, {
    id: "ERR-ITEMS",
    customerId: 5,
    status: "PENDING",
    itemsPurchasedAt: null,
    storeCount: 1,
    deliveryLatitude: 6.688,
    deliveryLongitude: 124.676,
    pinpoints: [],
    pabiliDetails: [{ quantity: 12 }],
    pabiliItemRequests: [],
    estimatedCost: 300,
    tip: 0,
    quotedHandlingFee: null,
    quotedDeliveryFee: null,
    multiStoreFee: 0,
    groceryFee: 0,
    nonCodFee: 0,
    distanceFee: 20,
    handlingFeeDecision: null,
    deliveryFee: 70,
    totalCost: 370,
    feeCalculatedAt: new Date(),
    routeDistanceMeters: 1000,
    routeProvider: "osrm",
  });
});

describe("updateItems", () => {
  it("re-prices after the edit, so the quote card carries the new fee", async () => {
    await updateItems("ERR-ITEMS", [{ itemName: "Eggs", quantity: 12, storeCategory: "Grocery" }] as any);
    expect(calculate).toHaveBeenCalled();
    expect(errandRepository.update).toHaveBeenCalledWith(
      "ERR-ITEMS",
      expect.objectContaining({ groceryFee: 50, totalCost: 420 })
    );
  });
});

describe("notifyDispatcherChatMessage", () => {
  it("refuses a customer pushing a message about someone else's errand", async () => {
    await expect(notifyDispatcherChatMessage("ERR-ITEMS", 6, "hello")).rejects.toMatchObject({ status: 403 });
    expect(notifyDispatcherCustomerChat).not.toHaveBeenCalled();
  });

  it("notifies the dispatcher for the errand's own customer", async () => {
    await notifyDispatcherChatMessage("ERR-ITEMS", 5, "hello");
    expect(notifyDispatcherCustomerChat).toHaveBeenCalledWith("ERR-ITEMS", 3, "Customer", "hello");
  });
});
