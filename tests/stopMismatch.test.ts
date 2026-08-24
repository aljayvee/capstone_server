import { beforeEach, describe, expect, it, vi } from "vitest";

// The two real Tacurong branches this feature exists for. 440 m apart — far
// enough that no geofence radius that still works could span them.
const JOLLIBEE_DT = { latitude: 6.689, longitude: 124.6788 };
const JOLLIBEE_MAIN = { latitude: 6.6873, longitude: 124.6752 };
const NOWHERE = { latitude: 6.6795, longitude: 124.6702 };

const DT_PLACE = "place-jollibee-dt";
const MAIN_PLACE = "place-jollibee-main";

const findByErrandId = vi.fn();
const markStopMismatch = vi.fn();
const findNearest = vi.fn();
const emitToErrand = vi.fn();

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: {
    emitToErrand: (...a: unknown[]) => emitToErrand(...a),
    emit: vi.fn(),
    emitToRole: vi.fn(),
    emitToRider: vi.fn(),
  },
}));
vi.mock("../src/repositories/pinpointRepository.js", () => ({
  pinpointRepository: {
    findByErrandId: (...a: unknown[]) => findByErrandId(...a),
    markStopMismatch: (...a: unknown[]) => markStopMismatch(...a),
    markArrived: vi.fn(),
    markDeparted: vi.fn(),
  },
}));
vi.mock("../src/repositories/placeRepository.js", () => ({
  placeRepository: { findNearest: (...a: unknown[]) => findNearest(...a) },
}));
vi.mock("../src/repositories/dwellObservationRepository.js", () => ({
  dwellObservationRepository: { existsForPinpoint: vi.fn(), create: vi.fn() },
}));

const { detectStopMismatch } = await import("../src/services/geofenceService.js");

const BASE = Date.UTC(2026, 7, 22, 10, 0, 0);

function dwellAt(at: { latitude: number; longitude: number }, minutes = 5) {
  return Array.from({ length: minutes }, (_, i) => ({
    ...at,
    recordedAt: new Date(BASE + i * 60_000),
  }));
}

function pinnedDT(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: 7,
      storeName: "Jollibee Tacurong Drive-Thru (DT)",
      ...JOLLIBEE_DT,
      categoryId: 1,
      placeId: DT_PLACE,
      arrivedAt: null,
      departedAt: null,
      mismatchDetectedAt: null,
      ...overrides,
    },
  ];
}

beforeEach(() => {
  findByErrandId.mockReset();
  markStopMismatch.mockReset().mockResolvedValue(undefined);
  findNearest.mockReset().mockResolvedValue(null);
  emitToErrand.mockReset();
});

describe("detectStopMismatch", () => {
  it("catches the rider at the other branch of the same chain", async () => {
    findByErrandId.mockResolvedValue(pinnedDT());
    findNearest.mockResolvedValue({
      place: { id: MAIN_PLACE, name: "Jollibee Tacurong Center (Main)", ...JOLLIBEE_MAIN },
      distanceMeters: 3,
    });

    const result = await detectStopMismatch("errand-1", dwellAt(JOLLIBEE_MAIN));

    expect(result).not.toBeNull();
    expect(result!.pinnedStoreName).toBe("Jollibee Tacurong Drive-Thru (DT)");
    expect(result!.observedPlaceName).toBe("Jollibee Tacurong Center (Main)");
    // The distance the geofence could never have covered.
    expect(result!.metersFromPinnedStop).toBeGreaterThan(400);
    expect(result!.metersFromPinnedStop).toBeLessThan(480);

    expect(markStopMismatch).toHaveBeenCalledWith(7, MAIN_PLACE, expect.any(Date));
    expect(emitToErrand).toHaveBeenCalledWith(
      "errand-1",
      "errand:stop_mismatch",
      expect.objectContaining({ errandId: "errand-1", pinpointId: 7 })
    );
  });

  it("stays quiet when the rider is at the stop that was pinned", async () => {
    findByErrandId.mockResolvedValue(pinnedDT());

    const result = await detectStopMismatch("errand-2", dwellAt(JOLLIBEE_DT));

    expect(result).toBeNull();
    // Every fix belongs to the pinned stop, so there is nothing to resolve and
    // the catalogue is never queried.
    expect(findNearest).not.toHaveBeenCalled();
    expect(emitToErrand).not.toHaveBeenCalled();
  });

  it("stays quiet for a stop pinned on a bare map", async () => {
    // No placeId means the dispatcher dropped a pin rather than picking from the
    // catalogue. There is nothing to compare against, and treating that as a
    // mismatch would fire on every off-catalogue errand.
    findByErrandId.mockResolvedValue(pinnedDT({ placeId: null }));
    findNearest.mockResolvedValue({
      place: { id: MAIN_PLACE, name: "Jollibee Tacurong Center (Main)", ...JOLLIBEE_MAIN },
      distanceMeters: 3,
    });

    const result = await detectStopMismatch("errand-3", dwellAt(JOLLIBEE_MAIN));

    expect(result).toBeNull();
    expect(emitToErrand).not.toHaveBeenCalled();
  });

  it("reports a given stop only once", async () => {
    findByErrandId.mockResolvedValue(pinnedDT({ mismatchDetectedAt: new Date(BASE) }));
    findNearest.mockResolvedValue({
      place: { id: MAIN_PLACE, name: "Jollibee Tacurong Center (Main)", ...JOLLIBEE_MAIN },
      distanceMeters: 3,
    });

    // A rider parked at the wrong branch keeps uploading breadcrumbs; dispatch
    // does not need the same alert every minute.
    const result = await detectStopMismatch("errand-4", dwellAt(JOLLIBEE_MAIN));

    expect(result).toBeNull();
    expect(markStopMismatch).not.toHaveBeenCalled();
    expect(emitToErrand).not.toHaveBeenCalled();
  });

  it("stays quiet when the rider stops somewhere uncatalogued", async () => {
    // Waiting at a junction is not visiting a store. findNearest finding nothing
    // within the radius is the honest answer, and no alert is better than naming
    // whatever shop happens to be closest.
    findByErrandId.mockResolvedValue(pinnedDT());
    findNearest.mockResolvedValue(null);

    const result = await detectStopMismatch("errand-5", dwellAt(NOWHERE));

    expect(result).toBeNull();
    expect(emitToErrand).not.toHaveBeenCalled();
  });

  it("does not fire on a rider merely passing a store on the way", async () => {
    // One fix near Jollibee Main, then settled at the pinned DT. A drive-past is
    // not a visit — same presence rule arrival detection uses.
    findByErrandId.mockResolvedValue(pinnedDT());
    const points = [
      { ...JOLLIBEE_MAIN, recordedAt: new Date(BASE) },
      ...dwellAt(JOLLIBEE_DT, 4).map((p, i) => ({ ...p, recordedAt: new Date(BASE + (i + 1) * 60_000) })),
    ];

    const result = await detectStopMismatch("errand-6", points);

    expect(result).toBeNull();
    expect(emitToErrand).not.toHaveBeenCalled();
  });

  it("stays quiet once every stop has been visited", async () => {
    findByErrandId.mockResolvedValue(pinnedDT({ arrivedAt: new Date(BASE), departedAt: new Date(BASE) }));

    const result = await detectStopMismatch("errand-7", dwellAt(JOLLIBEE_MAIN));

    expect(result).toBeNull();
    expect(findNearest).not.toHaveBeenCalled();
  });
});
