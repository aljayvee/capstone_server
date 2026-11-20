import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/errands/:id/track, the staff route replay (2026-11-20):
 * - an unknown errand is a 404, not an empty 200 trail;
 * - a dispatcher gets the same claim check as GET /api/errands/:id;
 * - points never expose id or clientPointId;
 * - more than 5000 fixes returns the first 5000 with truncated: true;
 * - a reassigned errand lists both riders.
 */

const { errandRepository, trackPointRepository, pinpointRepository, userRepository } = vi.hoisted(() => ({
  errandRepository: { findById: vi.fn(), nearestFixToDoorAtDelivery: vi.fn() },
  trackPointRepository: { listForReplay: vi.fn(), listForErrand: vi.fn() },
  pinpointRepository: { findByErrandId: vi.fn() },
  userRepository: { findNamesByIds: vi.fn() },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/config/env.js", async (orig) => ({
  ...(await orig<typeof import("../src/config/env.js")>()),
  JWT_SECRET: "test-secret",
}));
vi.mock("../src/repositories/errandRepository.js", () => ({ errandRepository }));
vi.mock("../src/repositories/trackPointRepository.js", () => ({ trackPointRepository }));
vi.mock("../src/repositories/pinpointRepository.js", () => ({ pinpointRepository }));
vi.mock("../src/repositories/userRepository.js", () => ({ userRepository }));
vi.mock("../src/lib/eventPublisher.js", () => ({ eventPublisher: { publish: vi.fn() } }));
vi.mock("../src/lib/riderLocationBroadcast.js", () => ({ broadcastRiderLocation: vi.fn() }));
vi.mock("../src/services/notificationService.js", () => ({}));

import { getTrack } from "../src/controllers/trackingController.js";
import { REPLAY_POINT_CAP } from "../src/services/trackingService.js";

const ERRAND_ID = "11111111-1111-4111-8111-111111111111";

function errandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ERRAND_ID,
    referenceNo: "261120-00001-0001",
    status: "COMPLETED",
    acceptedAt: new Date("2026-11-20T01:00:00Z"),
    deliveredAt: new Date("2026-11-20T01:40:00Z"),
    deliveryLatitude: 6.69,
    deliveryLongitude: 124.67,
    routeGeometry: "abc",
    etaPromisedHighAt: new Date("2026-11-20T01:45:00Z"),
    dispatchLogs: [{ dispatcherId: 3, dispatcher: { firstName: "Ana", lastName: "Cruz" } }],
    ...overrides,
  };
}

function fix(i: number, riderId = 21) {
  const at = new Date(Date.UTC(2026, 10, 20, 1, 0, i));
  return {
    latitude: 6.69 + i * 1e-5,
    longitude: 124.67,
    accuracyMeters: 8,
    speedMps: null,
    headingDeg: 90,
    recordedAt: at,
    receivedAt: at,
    isMapMatched: true,
    wasOffline: false,
    riderId,
  };
}

// Runs the asyncHandler-wrapped controller and resolves with what it sent or
// the error it passed to next().
function call(user: { id: number; role: string }) {
  return new Promise<{ status?: number; body?: any; error?: any }>((resolve) => {
    const res: any = {
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { resolve({ status: this.statusCode, body }); return this; },
    };
    getTrack({ params: { id: ERRAND_ID }, user } as any, res, (error: unknown) => resolve({ error }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  errandRepository.findById.mockResolvedValue(errandRow());
  errandRepository.nearestFixToDoorAtDelivery.mockResolvedValue(new Map([[ERRAND_ID, 12.5]]));
  trackPointRepository.listForReplay.mockResolvedValue([fix(0), fix(1)]);
  pinpointRepository.findByErrandId.mockResolvedValue([
    { id: 5, storeName: "Store A", sequence: 0, latitude: 6.7, longitude: 124.6, arrivedAt: new Date("2026-11-20T01:10:00Z"), departedAt: null, category: { geofenceRadiusMeters: 90 } },
    { id: 6, storeName: "Pin", sequence: 1, latitude: 6.71, longitude: 124.61, arrivedAt: null, departedAt: null, category: null },
  ]);
  userRepository.findNamesByIds.mockImplementation(async (ids: number[]) =>
    ids.map((id) => ({ id, firstName: id === 21 ? "Ben" : "Carl", lastName: "Reyes" }))
  );
});

describe("GET /api/errands/:id/track replay", () => {
  it("answers 404 for an unknown errand instead of an empty trail", async () => {
    errandRepository.findById.mockResolvedValue(null);
    const { error, body } = await call({ id: 1, role: "OWNER" });
    expect(body).toBeUndefined();
    expect(error?.status).toBe(404);
    expect(error.message).toBe("Errand not found");
    expect(trackPointRepository.listForReplay).not.toHaveBeenCalled();
  });

  it("refuses a dispatcher reading another dispatcher's claimed errand, with the errand record's wording", async () => {
    errandRepository.findById.mockResolvedValue(errandRow({ status: "IN_TRANSIT" }));
    const { error } = await call({ id: 4, role: "DISPATCHER" });
    expect(error?.status).toBe(403);
    expect(error.message).toBe("Access denied: This errand is currently assigned to Ana Cruz.");
    expect(trackPointRepository.listForReplay).not.toHaveBeenCalled();
  });

  it("lets the claiming dispatcher and any dispatcher on an AVAILABLE errand through", async () => {
    errandRepository.findById.mockResolvedValue(errandRow({ status: "IN_TRANSIT" }));
    expect((await call({ id: 3, role: "DISPATCHER" })).status).toBe(200);
    errandRepository.findById.mockResolvedValue(errandRow({ status: "AVAILABLE" }));
    expect((await call({ id: 4, role: "DISPATCHER" })).status).toBe(200);
  });

  it("returns the replay shape, with no row ids or clientPointId on points", async () => {
    const { status, body } = await call({ id: 1, role: "OWNER" });
    expect(status).toBe(200);
    expect(body.errandId).toBe(ERRAND_ID);
    expect(body.truncated).toBe(false);
    expect(body.points).toHaveLength(2);
    for (const p of body.points) {
      expect(p).not.toHaveProperty("clientPointId");
      expect(p).not.toHaveProperty("id");
      expect(Object.keys(p).sort()).toEqual(
        ["accuracyMeters", "headingDeg", "isMapMatched", "latitude", "longitude", "receivedAt", "recordedAt", "riderId", "speedMps", "wasOffline"]
      );
    }
    expect(body.points[0].recordedAt).toBe("2026-11-20T01:00:00.000Z");
    expect(body.errand).toEqual({
      referenceNo: "261120-00001-0001",
      status: "COMPLETED",
      acceptedAt: "2026-11-20T01:00:00.000Z",
      deliveredAt: "2026-11-20T01:40:00.000Z",
      deliveryLatitude: 6.69,
      deliveryLongitude: 124.67,
      routeGeometry: "abc",
      etaPromisedHighAt: "2026-11-20T01:45:00.000Z",
    });
    expect(body.stops).toEqual([
      { id: 5, storeName: "Store A", sequence: 0, latitude: 6.7, longitude: 124.6, arrivedAt: "2026-11-20T01:10:00.000Z", departedAt: null, geofenceRadiusMeters: 90 },
      { id: 6, storeName: "Pin", sequence: 1, latitude: 6.71, longitude: 124.61, arrivedAt: null, departedAt: null, geofenceRadiusMeters: 75 },
    ]);
    expect(body.nearestToDoorMeters).toBe(12.5);
    // The errand loaded for the access check is reused, not read twice.
    expect(errandRepository.findById).toHaveBeenCalledTimes(1);
  });

  it("caps the trail at 5000 points and says it was cut short", async () => {
    trackPointRepository.listForReplay.mockResolvedValue(
      Array.from({ length: REPLAY_POINT_CAP + 1 }, (_, i) => fix(i))
    );
    const { body } = await call({ id: 1, role: "OWNER" });
    expect(trackPointRepository.listForReplay).toHaveBeenCalledWith(ERRAND_ID, REPLAY_POINT_CAP + 1);
    expect(body.points).toHaveLength(5000);
    expect(body.truncated).toBe(true);
  });

  it("is not truncated at exactly 5000 points", async () => {
    trackPointRepository.listForReplay.mockResolvedValue(
      Array.from({ length: REPLAY_POINT_CAP }, (_, i) => fix(i))
    );
    const { body } = await call({ id: 1, role: "OWNER" });
    expect(body.points).toHaveLength(5000);
    expect(body.truncated).toBe(false);
  });

  it("lists both riders of a reassigned errand, in the order they rode", async () => {
    trackPointRepository.listForReplay.mockResolvedValue([fix(0, 21), fix(1, 21), fix(2, 34), fix(3, 34)]);
    const { body } = await call({ id: 1, role: "OWNER" });
    expect(body.riders).toEqual([
      { id: 21, name: "Ben Reyes" },
      { id: 34, name: "Carl Reyes" },
    ]);
  });

  it("reports no door distance for an errand without a delivery fix", async () => {
    errandRepository.nearestFixToDoorAtDelivery.mockResolvedValue(new Map());
    trackPointRepository.listForReplay.mockResolvedValue([]);
    const { body } = await call({ id: 1, role: "OWNER" });
    expect(body.nearestToDoorMeters).toBeNull();
    expect(body.points).toEqual([]);
    expect(body.riders).toEqual([]);
  });
});
