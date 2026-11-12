import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stop marked arrived by the rider's own tap ("GPS not detecting? Confirm
 * Arrival", pinpointArrivalService) while their GPS sits outside its circle.
 *
 * The departure rule took the first fix after arrival that the stop does not
 * own as the rider leaving. After a tap made because no fix was inside, that
 * is the very next fix: the stop was marked departed seconds after arrival,
 * with the rider still in the shop, and a dwell of seconds went into the data
 * every future ETA for the category is learned from.
 */

const markArrived = vi.fn();
const markDeparted = vi.fn();
const existsForPinpoint = vi.fn();
const createObservation = vi.fn();
const findInWindowNear = vi.fn();
const findNearestInTime = vi.fn();

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emitToErrand: vi.fn(), emit: vi.fn(), emitToRole: vi.fn(), emitToRider: vi.fn() },
}));
vi.mock("../src/repositories/pinpointRepository.js", () => ({
  pinpointRepository: {
    markArrived: (...a: unknown[]) => markArrived(...a),
    markDeparted: (...a: unknown[]) => markDeparted(...a),
    findByErrandId: vi.fn(),
    markStopMismatch: vi.fn(),
  },
}));
vi.mock("../src/repositories/dwellObservationRepository.js", () => ({
  dwellObservationRepository: {
    existsForPinpoint: (...a: unknown[]) => existsForPinpoint(...a),
    create: (...a: unknown[]) => createObservation(...a),
  },
}));
vi.mock("../src/repositories/trackPointRepository.js", () => ({
  trackPointRepository: {
    findInWindowNear: (...a: unknown[]) => findInWindowNear(...a),
    findNearestInTime: (...a: unknown[]) => findNearestInTime(...a),
  },
}));

const { applyGeofenceTransitions } = await import("../src/services/geofenceService.js");

// Rojon Pharmacy, Tacurong, with the default 75 m circle.
const STORE = { latitude: 6.683398, longitude: 124.665008 };
const M = 111_195;
const north = (meters: number) => ({ latitude: STORE.latitude + meters / M, longitude: STORE.longitude });
const T0 = Date.UTC(2026, 10, 10, 6, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const fix = (meters: number, seconds: number) => ({ ...north(meters), recordedAt: at(seconds) });

/** The stop as the tap left it: arrived at T0 + 0, not departed. */
const tapped = { id: 781, ...STORE, categoryId: 2, placeId: null, arrivedAt: at(0), departedAt: null };

beforeEach(() => {
  markArrived.mockReset().mockResolvedValue({ count: 1 });
  markDeparted.mockReset().mockResolvedValue(undefined);
  existsForPinpoint.mockReset().mockResolvedValue(false);
  createObservation.mockReset().mockResolvedValue(undefined);
  findInWindowNear.mockReset().mockResolvedValue([]);
  findNearestInTime.mockReset().mockResolvedValue(fix(110, 0));
});

describe("departure after an arrival the rider confirmed by hand", () => {
  it("is not taken from a phone that has sat 110 m off the pin since the tap", async () => {
    // Five minutes in the shop, every fix 105 to 115 m north of the pin.
    const shopping = Array.from({ length: 30 }, (_, i) => fix(110 + ((i * 7) % 11) - 5, 10 + i * 10));
    const transitions = await applyGeofenceTransitions("e-1", [tapped], shopping);

    expect(markDeparted).not.toHaveBeenCalled();
    expect(transitions).toEqual([]);
    expect(createObservation).not.toHaveBeenCalled();
  });

  it("is taken once the rider has moved a full radius from where the phone put them", async () => {
    // Still in the shop for two minutes, then riding north at 8 m/s.
    const shopping = Array.from({ length: 12 }, (_, i) => fix(110, 10 + i * 10));
    const riding = Array.from({ length: 15 }, (_, i) => fix(110 + (i + 1) * 8, 130 + i));
    const transitions = await applyGeofenceTransitions("e-1", [tapped], [...shopping, ...riding]);

    expect(markDeparted).toHaveBeenCalledTimes(1);
    const [, departedAt] = markDeparted.mock.calls[0];
    // The first fix more than 75 m from the anchor at 110 m: 110 + 80 = 190 m, ten seconds into the ride.
    expect(departedAt).toEqual(at(139));
    expect(transitions).toEqual([{ pinpointId: 781, kind: "departed", at: at(139), dwellSeconds: 139 }]);
  });

  it("keeps a visit no fix ever saw out of the dwell data", async () => {
    const riding = Array.from({ length: 15 }, (_, i) => fix(110 + (i + 1) * 8, 130 + i));
    await applyGeofenceTransitions("e-1", [tapped], riding);

    expect(markDeparted).toHaveBeenCalledTimes(1);
    expect(createObservation).not.toHaveBeenCalled();
  });

  it("waits for the trail when there is none to anchor on", async () => {
    findNearestInTime.mockResolvedValue(null);
    await applyGeofenceTransitions("e-1", [tapped], [fix(300, 60)]);
    expect(markDeparted).not.toHaveBeenCalled();
  });

  it("uses the ordinary rule once a fix has placed the rider inside since the tap", async () => {
    // A stored fix 20 m from the pin, a minute after the tap, from an earlier batch.
    findInWindowNear.mockResolvedValue([fix(20, 60)]);
    const transitions = await applyGeofenceTransitions("e-1", [tapped], [fix(110, 300)]);

    expect(markDeparted).toHaveBeenCalledWith(781, at(300));
    expect(transitions[0]).toMatchObject({ kind: "departed", at: at(300), dwellSeconds: 300 });
    expect(createObservation).toHaveBeenCalledTimes(1);
  });
});

describe("departure after an arrival the GPS made (unchanged)", () => {
  it("in the same batch: departs on the first fix outside, with no query", async () => {
    const fresh = { ...tapped, arrivedAt: null };
    const inside = Array.from({ length: 5 }, (_, i) => fix(10, i * 60));
    const transitions = await applyGeofenceTransitions("e-1", [fresh], [...inside, fix(200, 300)]);

    expect(transitions.map((t) => t.kind)).toEqual(["arrived", "departed"]);
    expect(markDeparted).toHaveBeenCalledWith(781, at(300));
    expect(createObservation).toHaveBeenCalledTimes(1);
    expect(findInWindowNear).not.toHaveBeenCalled();
    expect(findNearestInTime).not.toHaveBeenCalled();
  });

  it("in an earlier batch: departs on the first fix outside, found by the stored trail", async () => {
    // Arrived by GPS at T0 (that fix is stored), and this batch has the rider already gone.
    findInWindowNear.mockResolvedValue([fix(10, 0), fix(12, 60)]);
    await applyGeofenceTransitions("e-1", [tapped], [fix(200, 400), fix(260, 410)]);

    expect(markDeparted).toHaveBeenCalledWith(781, at(400));
    expect(createObservation).toHaveBeenCalledTimes(1);
    expect(findNearestInTime).not.toHaveBeenCalled();
    // Asked for the window from arrival to that fix, in a box around the stop.
    const [errandId, from, until, box] = findInWindowNear.mock.calls[0];
    expect([errandId, from, until]).toEqual(["e-1", at(0), at(400)]);
    expect(box.minLatitude).toBeLessThan(STORE.latitude);
    expect(box.maxLatitude).toBeGreaterThan(STORE.latitude);
  });

  it("does not count a stored fix nearer another stop as being at this one", async () => {
    // A second stop 40 m north: a fix 30 m north is inside both circles but belongs to it.
    const neighbour = { ...tapped, id: 782, ...north(40), arrivedAt: null };
    findInWindowNear.mockResolvedValue([fix(30, 60)]);
    findNearestInTime.mockResolvedValue(fix(110, 0));
    await applyGeofenceTransitions("e-1", [tapped, neighbour], [fix(130, 300)]);

    // Not seen at 781, and 130 m is only 20 m from the anchor: still there.
    expect(markDeparted).not.toHaveBeenCalledWith(781, expect.anything());
  });
});
