import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Re-pinning an errand whose rider has already filed a receipt.
 *
 * savePinpoints used to delete and recreate every stop, and the FK on
 * ErrandProofImage.pinpointId is SET NULL, so re-sending the stores mid-errand
 * cut every receipt loose from the store it was bought at (2026-10-09). A stop
 * with a receipt is now kept in place; one that would be dropped is refused.
 */

const ERRAND_ID = "ERR-KEEP";

const { errand, existingStops, pinpointRepository, checkStoreLocation } = vi.hoisted(() => ({
  errand: {} as any,
  existingStops: [] as any[],
  pinpointRepository: {
    findWithProofCounts: vi.fn(),
    replaceForErrand: vi.fn(async () => undefined),
    replaceForErrandKeeping: vi.fn(async () => undefined),
    findByErrandId: vi.fn(async () => []),
    findByErrandIdWithCategory: vi.fn(async () => []),
  },
  checkStoreLocation: vi.fn(),
}));

vi.mock("../src/repositories/pinpointRepository.js", () => ({ pinpointRepository }));
vi.mock("../src/repositories/pabiliItemRepository.js", () => ({
  pabiliItemRepository: { attachToPinpoints: vi.fn(async () => 0) },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findById: vi.fn(async () => errand),
    findByIdBasic: vi.fn(async () => errand),
    update: vi.fn(async (_: string, data: object) => ({ ...errand, ...data })),
  },
  dispatchLogRepository: {},
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
vi.mock("../src/services/patterns/pricingStrategy.js", () => ({
  defaultPricingStrategy: {
    calculate: vi.fn(() => ({
      deliveryFee: 70,
      totalCost: 370,
      multiStoreFee: 0,
      groceryFee: 0,
      nonCodFee: 0,
      distanceFee: 20,
      handlingDecision: { tier: "NONE" },
    })),
  },
}));
vi.mock("../src/services/patterns/categoryFeeModes.js", () => ({
  resolveCategoryModes: vi.fn(async () => ["THRESHOLD"]),
  modesForCategoryNames: vi.fn(async () => []),
}));
vi.mock("../src/services/patterns/handlingEvidence.js", () => ({
  resolveHandlingEvidence: vi.fn(async () => ({})),
}));
vi.mock("../src/services/storeLocationGuard.js", () => ({ checkStoreLocation }));
vi.mock("../src/services/notificationService.js", () => ({ notifyFeeUpdated: vi.fn(async () => undefined) }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn(), emitToRole: vi.fn(), emitToRider: vi.fn(), emitToCustomer: vi.fn() },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { savePinpoints } = await import("../src/services/errandService.js");

const KIMSAN = { storeName: "Kimsan Plaza", latitude: 6.7, longitude: 124.69, placeId: null, categoryId: 4 };
const ROJON = { storeName: "Rojon pharmacy", latitude: 6.6921, longitude: 124.6701, placeId: null, categoryId: 2 };
const JULIES = { storeName: "Julie's Bakeshop", latitude: 6.6852, longitude: 124.6789, placeId: null, categoryId: 5 };

const stop = (id: number, pin: typeof KIMSAN, receipts: number) => ({
  id,
  storeName: pin.storeName,
  latitude: pin.latitude,
  longitude: pin.longitude,
  placeId: pin.placeId,
  _count: { proofImages: receipts },
});

beforeEach(() => {
  vi.clearAllMocks();
  existingStops.length = 0;
  pinpointRepository.findWithProofCounts.mockImplementation(async () => existingStops);
  Object.assign(errand, {
    id: ERRAND_ID,
    customerId: 3,
    storeCount: 1,
    deliveryLatitude: 6.688,
    deliveryLongitude: 124.676,
    pinpoints: [KIMSAN],
    pabiliDetails: [],
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
  });
  checkStoreLocation.mockResolvedValue({ status: "inside", reason: "inside_border", kmBeyondBorder: 0 });
});

describe("savePinpoints with receipts on file", () => {
  it("replaces everything, as before, while no stop has a receipt", async () => {
    existingStops.push(stop(11, KIMSAN, 0));
    await savePinpoints(ERRAND_ID, [ROJON] as any);
    expect(pinpointRepository.replaceForErrand).toHaveBeenCalledWith(ERRAND_ID, [ROJON]);
    expect(pinpointRepository.replaceForErrandKeeping).not.toHaveBeenCalled();
  });

  it("keeps the receipt's stop by id, wherever it now sits in the order", async () => {
    existingStops.push(stop(11, KIMSAN, 1), stop(12, ROJON, 0));
    await savePinpoints(ERRAND_ID, [JULIES, KIMSAN] as any);
    expect(pinpointRepository.replaceForErrand).not.toHaveBeenCalled();
    expect(pinpointRepository.replaceForErrandKeeping).toHaveBeenCalledWith(ERRAND_ID, [JULIES, KIMSAN], [null, 11]);
  });

  it("lets a stop without a receipt go, such as a closed store the rider only reached", async () => {
    existingStops.push(stop(11, KIMSAN, 2), stop(12, ROJON, 0));
    await savePinpoints(ERRAND_ID, [KIMSAN, JULIES] as any);
    expect(pinpointRepository.replaceForErrandKeeping).toHaveBeenCalledWith(ERRAND_ID, [KIMSAN, JULIES], [11, null]);
  });

  it("refuses to drop a stop that has a receipt, and names it", async () => {
    existingStops.push(stop(11, KIMSAN, 1));
    await expect(savePinpoints(ERRAND_ID, [ROJON] as any)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Kimsan Plaza"),
    });
    expect(pinpointRepository.replaceForErrand).not.toHaveBeenCalled();
    expect(pinpointRepository.replaceForErrandKeeping).not.toHaveBeenCalled();
  });

  it("refuses to move it to another spot under the same name", async () => {
    existingStops.push(stop(11, KIMSAN, 1));
    const moved = { ...KIMSAN, latitude: KIMSAN.latitude + 0.001 }; // about 110 m
    await expect(savePinpoints(ERRAND_ID, [moved] as any)).rejects.toMatchObject({ status: 409 });
  });

  it("matches on the catalogue id when both sides have one", async () => {
    const pinned = { ...KIMSAN, placeId: "place-kimsan" };
    existingStops.push(stop(11, pinned, 1));
    const renamed = { ...pinned, storeName: "KCC Kimsan" };
    await savePinpoints(ERRAND_ID, [renamed] as any);
    expect(pinpointRepository.replaceForErrandKeeping).toHaveBeenCalledWith(ERRAND_ID, [renamed], [11]);
  });
});
