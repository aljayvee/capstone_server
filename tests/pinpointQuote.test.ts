import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Step 3's live fee: POST /errands/:id/pinpoints/quote.
 *
 * The dispatcher used to see the delivery fee only after pressing "send the
 * stores to the customer", because the fee was computed as part of saving. The
 * preview runs the same calculation (errandService.priceForStops) on the pins
 * on screen. What matters: it prices THOSE pins, it writes nothing, and it
 * tells the customer nothing. Saving still does both, once.
 */

const ERRAND_ID = "ERR-QUOTE";
const SAVED = { storeName: "Kimsan Plaza", latitude: 6.7, longitude: 124.69, placeId: null, categoryId: 4 };

const { errand, routeDistanceKm, calculate, resolveCategoryModes, checkStoreLocation } = vi.hoisted(() => ({
  errand: {} as any,
  routeDistanceKm: vi.fn(),
  // A stand-in price: 50 base, 10 per extra store, 10 per km. The real
  // arithmetic is pricingStrategy's own tests; this checks what reaches it.
  calculate: vi.fn((input: any) => {
    const multiStoreFee = Math.max(0, input.storeCount - 1) * 10;
    const distanceFee = Math.round(input.distanceKm * 10);
    const deliveryFee = 50 + multiStoreFee + distanceFee;
    return {
      deliveryFee,
      totalCost: deliveryFee + input.estimatedCost + input.tip,
      multiStoreFee,
      groceryFee: 0,
      nonCodFee: 0,
      distanceFee,
      handlingDecision: { tier: "NONE" },
    };
  }),
  resolveCategoryModes: vi.fn(async () => ["THRESHOLD"]),
  checkStoreLocation: vi.fn(),
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
vi.mock("../src/services/routingService.js", () => ({ routeDistanceKm }));
vi.mock("../src/services/patterns/pricingStrategy.js", () => ({ defaultPricingStrategy: { calculate } }));
vi.mock("../src/services/patterns/categoryFeeModes.js", () => ({
  resolveCategoryModes,
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

const { errandRepository } = await import("../src/repositories/errandRepository.js");
const { customerTransactionRepository } = await import("../src/repositories/customerTransactionRepository.js");
const notificationService = await import("../src/services/notificationService.js");
const { eventPublisher } = await import("../src/lib/eventPublisher.js");
const { quotePinpoints, savePinpoints, recalculateFee } = await import("../src/services/errandService.js");

const PROPOSED = [
  { storeName: "Rojon pharmacy", latitude: 6.6921, longitude: 124.6701, placeId: null, categoryId: 2 },
  { storeName: "Julie's Bakeshop", latitude: 6.6852, longitude: 124.6789, placeId: null, categoryId: 5 },
];

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(errand, {
    id: ERRAND_ID,
    customerId: 3,
    storeCount: 1,
    deliveryLatitude: 6.688,
    deliveryLongitude: 124.676,
    pinpoints: [SAVED],
    pabiliDetails: [{ quantity: 2 }],
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
    routeDistanceMeters: 2000,
    routeProvider: "osrm",
  });
  routeDistanceKm.mockImplementation(async (stops: unknown[]) => ({
    distanceKm: 1.5 * stops.length,
    result: { distanceMeters: 1500 * stops.length, durationSeconds: 300, encodedGeometry: null, provider: "osrm" },
  }));
  checkStoreLocation.mockResolvedValue({ status: "inside", reason: "inside_border", kmBeyondBorder: 0 });
});

describe("quotePinpoints", () => {
  it("prices the pins on screen, not the ones saved", async () => {
    const quote = await quotePinpoints(ERRAND_ID, PROPOSED as any);

    expect(routeDistanceKm).toHaveBeenCalledWith(
      PROPOSED.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
      { latitude: 6.688, longitude: 124.676 }
    );
    expect(calculate.mock.calls[0][0]).toMatchObject({ storeCount: 2, distanceKm: 3 });
    expect(resolveCategoryModes).toHaveBeenCalledWith(ERRAND_ID, [2, 5]);
    expect(quote).toMatchObject({
      deliveryFee: 90, // 50 + 10 for the second store + 30 for 3 km
      totalCost: 390,
      multiStoreFee: 10,
      distanceFee: 30,
      distanceKm: 3,
      estimated: false,
      fareAgreed: false,
      stops: 2,
    });
  });

  it("writes nothing and tells the customer nothing", async () => {
    await quotePinpoints(ERRAND_ID, PROPOSED as any);
    expect(errandRepository.update).not.toHaveBeenCalled();
    expect(customerTransactionRepository.updateAmountByErrandId).not.toHaveBeenCalled();
    expect(notificationService.notifyFeeUpdated).not.toHaveBeenCalled();
    expect(eventPublisher.emit).not.toHaveBeenCalled();
    expect(eventPublisher.emitToErrandParties).not.toHaveBeenCalled();
  });

  it("refuses a stop the router cannot reach, as saving does", async () => {
    checkStoreLocation.mockResolvedValueOnce({ status: "blocked", message: "is off the road map" });
    await expect(quotePinpoints(ERRAND_ID, PROPOSED as any)).rejects.toMatchObject({ status: 422 });
    expect(calculate).not.toHaveBeenCalled();
  });

  it("strictly refuses to save stops outside the Tacurong service area or off the map with 422", async () => {
    checkStoreLocation.mockResolvedValueOnce({
      status: "blocked",
      reason: "outside_border",
      message: "This store is outside Tacurong City. SUGO Express currently operates exclusively within Tacurong City.",
    });
    await expect(savePinpoints(ERRAND_ID, PROPOSED as any)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("outside Tacurong City"),
    });
  });

  it("shows the agreed fare, not a new one, once the customer has agreed", async () => {
    errand.quotedDeliveryFee = 80;
    const quote = await quotePinpoints(ERRAND_ID, PROPOSED as any);
    expect(quote.fareAgreed).toBe(true);
    expect(quote.deliveryFee).toBe(80);
  });

  it("says when the distance is a straight-line estimate", async () => {
    routeDistanceKm.mockResolvedValueOnce(null);
    const quote = await quotePinpoints(ERRAND_ID, PROPOSED as any);
    expect(quote.estimated).toBe(true);
  });
});

describe("recalculateFee after the split", () => {
  it("still prices the saved pins, writes the fee and tells the customer", async () => {
    await recalculateFee(ERRAND_ID);
    expect(routeDistanceKm).toHaveBeenCalledWith(
      [{ latitude: SAVED.latitude, longitude: SAVED.longitude }],
      { latitude: 6.688, longitude: 124.676 }
    );
    expect(resolveCategoryModes).toHaveBeenCalledWith(ERRAND_ID);
    expect(errandRepository.update).toHaveBeenCalledWith(
      ERRAND_ID,
      expect.objectContaining({ deliveryFee: 65, totalCost: 365, distanceFee: 15 })
    );
    expect(notificationService.notifyFeeUpdated).toHaveBeenCalledWith(3, ERRAND_ID, 365);
  });
});
