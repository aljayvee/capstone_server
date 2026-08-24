import { beforeEach, describe, expect, it, vi } from "vitest";

// Real catalogue coordinates. The distances between them are the whole point of
// these tests, so they are not rounded or invented.
const JOLLIBEE_MAIN = { latitude: 6.6873, longitude: 124.6752 };
const GREENWICH = { latitude: 6.6869, longitude: 124.6745 }; // ~89 m from Jollibee Main
const JOLLIBEE_DT = { latitude: 6.689, longitude: 124.6788 }; // ~440 m from Jollibee Main

const markArrived = vi.fn();
const markDeparted = vi.fn();
const existsForPinpoint = vi.fn();
const createObservation = vi.fn();

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

const { applyGeofenceTransitions, GEOFENCE_RADIUS_METERS } = await import(
  "../src/services/geofenceService.js"
);

function stop(id: number, at: { latitude: number; longitude: number }) {
  return { id, ...at, categoryId: null, placeId: null, arrivedAt: null, departedAt: null };
}

// A breadcrumb sitting at one spot, one fix a minute — long enough to clear the
// sustained-presence rule without relying on the "still there at the end"
// shortcut.
function dwellAt(at: { latitude: number; longitude: number }, minutes = 5) {
  const base = Date.UTC(2026, 7, 22, 10, 0, 0);
  return Array.from({ length: minutes }, (_, i) => ({
    ...at,
    recordedAt: new Date(base + i * 60_000),
  }));
}

beforeEach(() => {
  markArrived.mockReset().mockResolvedValue(undefined);
  markDeparted.mockReset().mockResolvedValue(undefined);
  existsForPinpoint.mockReset().mockResolvedValue(false);
  createObservation.mockReset().mockResolvedValue(undefined);
});

describe("geofence attribution with overlapping radii", () => {
  it("gives a contested fix to exactly one stop — the nearer", async () => {
    // Jollibee Main and Greenwich are ~89 m apart, so their 75 m circles overlap
    // and a rider between them is genuinely inside both. Before nearest-wins,
    // this recorded an arrival at BOTH — inventing a visit to a store the rider
    // never entered, and writing a dwell observation that skews that category's
    // percentiles for every future ETA.
    const midpoint = {
      latitude: (JOLLIBEE_MAIN.latitude + GREENWICH.latitude) / 2,
      longitude: (JOLLIBEE_MAIN.longitude + GREENWICH.longitude) / 2,
    };
    // Nudged towards Greenwich so there is an unambiguous correct answer.
    const leaning = { latitude: midpoint.latitude - 0.00005, longitude: midpoint.longitude - 0.00008 };

    const transitions = await applyGeofenceTransitions(
      "errand-1",
      [stop(1, JOLLIBEE_MAIN), stop(2, GREENWICH)],
      dwellAt(leaning)
    );

    const arrivals = transitions.filter((t) => t.kind === "arrived");
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].pinpointId).toBe(2);
    expect(markArrived).toHaveBeenCalledTimes(1);
  });

  it("still records a normal arrival when only one stop is in range", async () => {
    // 440 m apart: no overlap, nothing contested. The attribution pass must not
    // disturb the ordinary case.
    const transitions = await applyGeofenceTransitions(
      "errand-2",
      [stop(1, JOLLIBEE_MAIN), stop(2, JOLLIBEE_DT)],
      dwellAt(JOLLIBEE_MAIN)
    );

    const arrivals = transitions.filter((t) => t.kind === "arrived");
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].pinpointId).toBe(1);
  });

  it("records no arrival when the rider is inside nobody's radius", async () => {
    const transitions = await applyGeofenceTransitions(
      "errand-3",
      [stop(1, JOLLIBEE_DT)],
      dwellAt(JOLLIBEE_MAIN)
    );

    expect(transitions).toHaveLength(0);
    expect(markArrived).not.toHaveBeenCalled();
  });

  it("treats crossing to the next-door store as a departure", async () => {
    // Moving from Jollibee Main to Greenwich never leaves both radii, so a
    // departure test written as "first fix outside MY radius" would never fire
    // and the stop would stay open forever. Ownership changing is the signal.
    const points = [...dwellAt(JOLLIBEE_MAIN, 3)];
    const base = points[points.length - 1].recordedAt.getTime();
    points.push(
      { ...GREENWICH, recordedAt: new Date(base + 60_000) },
      { ...GREENWICH, recordedAt: new Date(base + 120_000) }
    );

    const transitions = await applyGeofenceTransitions(
      "errand-4",
      [stop(1, JOLLIBEE_MAIN), stop(2, GREENWICH)],
      points
    );

    const departures = transitions.filter((t) => t.kind === "departed");
    expect(departures).toHaveLength(1);
    expect(departures[0].pinpointId).toBe(1);
    expect(departures[0].dwellSeconds).toBeGreaterThan(0);
    expect(createObservation).toHaveBeenCalledTimes(1);
  });

  it("keeps a radius wide enough to survive ordinary GPS error", () => {
    // Guards against "fixing" the overlap by shrinking the radius, which would
    // trade invented arrivals for missed ones.
    expect(GEOFENCE_RADIUS_METERS).toBe(75);
  });
});
