import { beforeEach, describe, expect, it, vi } from "vitest";

const { findById, update, freezeEtaPromise, getFresh, compute } = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  freezeEtaPromise: vi.fn(),
  getFresh: vi.fn(),
  compute: vi.fn(),
}));

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findById, update, freezeEtaPromise },
}));
vi.mock("../src/repositories/pinpointRepository.js", () => ({
  pinpointRepository: { findByErrandIdWithCategory: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../src/lib/riderPositionStore.js", () => ({ getFresh }));
vi.mock("../src/services/patterns/etaStrategy.js", () => ({ defaultEtaStrategy: { compute } }));
vi.mock("../src/lib/eventPublisher.js", () => ({ eventPublisher: { emitToErrand: vi.fn() } }));
vi.mock("../src/services/deliveryReminderService.js", () => ({
  inBackground: vi.fn(),
  onDeliveryEta: vi.fn(),
}));
vi.mock("../src/services/deliveryHoldService.js", () => ({ findDeliveryHold: vi.fn().mockResolvedValue(null) }));
vi.mock("../src/services/notificationService.js", () => ({ notifyStaffAboutErrand: vi.fn() }));

import { recomputeForErrand } from "../src/services/etaService.js";

const HIGH = new Date("2026-10-22T06:30:00Z");

function onTheWayToTheDoor(over: Record<string, unknown> = {}) {
  return {
    id: "errand-1",
    status: "IN_TRANSIT",
    riderId: 7,
    deliveryLatitude: 6.68,
    deliveryLongitude: 124.67,
    itemsPurchasedAt: new Date("2026-10-22T06:00:00Z"),
    etaComputedAt: null,
    etaPromisedAt: null,
    ...over,
  };
}

function estimate(over: Record<string, unknown> = {}) {
  return {
    etaLowAt: new Date("2026-10-22T06:20:00Z"),
    etaHighAt: HIGH,
    travelSeconds: 900,
    dwellLowSeconds: 0,
    dwellHighSeconds: 0,
    remainingStopCount: 0,
    degraded: false,
    provider: "google",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  freezeEtaPromise.mockResolvedValue({ count: 1 });
  getFresh.mockReturnValue({ point: { latitude: 6.69, longitude: 124.66 } });
  compute.mockResolvedValue(estimate());
});

describe("freezing the delivery promise", () => {
  it("freezes the first routed estimate from a live fix once no store is left", async () => {
    findById.mockResolvedValue(onTheWayToTheDoor());

    await recomputeForErrand("errand-1", { force: true });

    expect(freezeEtaPromise).toHaveBeenCalledTimes(1);
    const [id, riderId, promisedAt, promisedHigh] = freezeEtaPromise.mock.calls[0];
    expect([id, riderId, promisedHigh]).toEqual(["errand-1", 7, HIGH]);
    expect(promisedAt).toBeInstanceOf(Date);
  });

  it("leaves an existing promise alone", async () => {
    findById.mockResolvedValue(onTheWayToTheDoor({ etaPromisedAt: new Date("2026-10-22T06:01:00Z") }));

    await recomputeForErrand("errand-1", { force: true });
    expect(freezeEtaPromise).not.toHaveBeenCalled();
    // The customer's countdown still moves.
    expect(update).toHaveBeenCalledWith("errand-1", expect.objectContaining({ etaHighAt: HIGH }));
  });

  it("waits while a store is still ahead", async () => {
    findById.mockResolvedValue(onTheWayToTheDoor({ itemsPurchasedAt: null }));
    compute.mockResolvedValue(estimate({ remainingStopCount: 1 }));

    await recomputeForErrand("errand-1", { force: true });
    expect(freezeEtaPromise).not.toHaveBeenCalled();
  });

  it("never freezes a fallback estimate", async () => {
    findById.mockResolvedValue(onTheWayToTheDoor());
    compute.mockResolvedValue(estimate({ degraded: true }));

    await recomputeForErrand("errand-1", { force: true });
    expect(freezeEtaPromise).not.toHaveBeenCalled();
  });

  it("never freezes an estimate made without a live GPS fix", async () => {
    findById.mockResolvedValue(onTheWayToTheDoor());
    getFresh.mockReturnValue(undefined);

    await recomputeForErrand("errand-1", { force: true });
    expect(freezeEtaPromise).not.toHaveBeenCalled();
  });

  it("makes no promise before the rider has accepted", async () => {
    findById.mockResolvedValue(onTheWayToTheDoor({ status: "ASSIGNED" }));

    await recomputeForErrand("errand-1", { force: true });
    expect(freezeEtaPromise).not.toHaveBeenCalled();
  });
});
