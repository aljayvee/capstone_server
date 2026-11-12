import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dispatch isolation between service zones (2026-11-09).
 *
 * A Banga rider never receives a Tacurong errand, and the other way round.
 * Before this, the ranking only asked "inside any service area", and the
 * least-loaded and back-of-queue fallbacks asked nothing, so the other zone's
 * riders always trailed at the back of the queue.
 *
 * Every claim is answered AT_CAPACITY here, so assignRider walks its whole
 * queue and `state.claims` is exactly the queue it built.
 */

const { state } = vi.hoisted(() => ({
  state: { errand: {} as any, riders: [] as any[], claims: [] as number[] },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errand: { groupBy: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => state.riders) },
  },
}));
vi.mock("../src/repositories/errandRepository.js", async (original) => {
  const actual = await original<typeof import("../src/repositories/errandRepository.js")>();
  return {
    ...actual,
    errandRepository: {
      ...actual.errandRepository,
      findById: vi.fn(async () => state.errand),
      claimForRider: vi.fn(async (_errandId: string, riderId: number) => {
        state.claims.push(riderId);
        return "AT_CAPACITY";
      }),
    },
  };
});
vi.mock("../src/repositories/userRepository.js", async (original) => {
  const actual = await original<typeof import("../src/repositories/userRepository.js")>();
  return {
    ...actual,
    userRepository: { ...actual.userRepository, findById: vi.fn(async (id: number) => ({ id, role: "RIDER" })) },
  };
});
vi.mock("../src/services/riderBeaconService.js", async (original) => ({
  ...(await original<typeof import("../src/services/riderBeaconService.js")>()),
  availabilityForRiders: vi.fn(
    async (ids: number[]) =>
      new Map(
        ids.map((id) => [
          id,
          { state: "AVAILABLE", dispatchable: true, impediments: [], beaconAgeMs: 5000, riderStatus: "AVAILABLE_ONLINE" },
        ])
      )
  ),
}));
vi.mock("../src/lib/routing/resilientRoutingService.js", async (original) => ({
  ...(await original<typeof import("../src/lib/routing/resilientRoutingService.js")>()),
  // No routing engine: ranking falls back to straight-line distance.
  matrix: vi.fn(async () => null),
}));
vi.mock("../src/services/etaService.js", async (original) => ({
  ...(await original<typeof import("../src/services/etaService.js")>()),
  recomputeInBackground: vi.fn(),
}));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn(), emitToRole: vi.fn(), emitToRider: vi.fn(), emitToCustomer: vi.fn() },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { assignRider } = await import("../src/services/errandService.js");
const riderPositionStore = await import("../src/lib/riderPositionStore.js");
const { errandServiceZone, namedRiderZoneConflict, riderMayTakeZone } = await import("../src/services/dispatchZone.js");

const TACURONG_STORE = { latitude: 6.6873, longitude: 124.6752 };
const TACURONG_DOOR = { latitude: 6.688, longitude: 124.676 };
const BANGA_STORE = { latitude: 6.4232, longitude: 124.7762 };
const BANGA_DOOR = { latitude: 6.4, longitude: 124.78 };
const KORONADAL = { latitude: 6.5025, longitude: 124.8469 };

const TACURONG_RIDER = 11;
const BANGA_RIDER = 12;
const NO_FIX_RIDER = 13;

const rider = (id: number) => ({ id, firstName: "Rider", lastName: String(id), errandsAsRider: [] });
const errandAt = (store: typeof TACURONG_STORE, door: typeof TACURONG_DOOR) => ({
  id: "ERR-ZONE",
  status: "PENDING",
  customerId: 5,
  pinpoints: [{ latitude: store.latitude, longitude: store.longitude }],
  deliveryLatitude: door.latitude,
  deliveryLongitude: door.longitude,
});
const fixAt = (riderId: number, point: typeof TACURONG_STORE, ageMs = 1000) =>
  riderPositionStore.record(riderId, {
    point,
    recordedAt: Date.now() - ageMs,
    accuracyMeters: 5,
    headingDeg: null,
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.claims = [];
  state.riders = [rider(TACURONG_RIDER), rider(BANGA_RIDER), rider(NO_FIX_RIDER)];
  for (const id of [TACURONG_RIDER, BANGA_RIDER, NO_FIX_RIDER]) riderPositionStore.clear(id);
  fixAt(TACURONG_RIDER, { latitude: 6.69, longitude: 124.68 });
  fixAt(BANGA_RIDER, { latitude: 6.42, longitude: 124.77 });
});

describe("the zone rules", () => {
  it("takes the errand's zone from its first store, else its drop-off", () => {
    expect(errandServiceZone(errandAt(BANGA_STORE, BANGA_DOOR))).toBe("BANGA");
    expect(errandServiceZone({ pinpoints: [], deliveryLatitude: 6.688, deliveryLongitude: 124.676 })).toBe("TACURONG");
    expect(errandServiceZone({ pinpoints: [] })).toBeNull();
  });

  it("lets a rider take only their own zone's errands", () => {
    expect(riderMayTakeZone(TACURONG_DOOR, "TACURONG")).toBe(true);
    expect(riderMayTakeZone(BANGA_DOOR, "TACURONG")).toBe(false);
    expect(riderMayTakeZone(TACURONG_DOOR, "BANGA")).toBe(false);
    expect(riderMayTakeZone(KORONADAL, "BANGA")).toBe(false);
    expect(riderMayTakeZone(undefined, "TACURONG")).toBe(false);
    expect(riderMayTakeZone(TACURONG_DOOR, null)).toBe(false);
  });

  it("refuses a named rider only on a fix in the other zone", () => {
    expect(namedRiderZoneConflict(BANGA_DOOR, "TACURONG")).toBe("BANGA");
    expect(namedRiderZoneConflict(TACURONG_DOOR, "TACURONG")).toBeNull();
    expect(namedRiderZoneConflict(undefined, "TACURONG")).toBeNull();
    expect(namedRiderZoneConflict(KORONADAL, "TACURONG")).toBeNull();
  });
});

describe("assignRider keeps each zone's riders to their own errands", () => {
  it("queues only the Tacurong rider for a Tacurong errand", async () => {
    state.errand = errandAt(TACURONG_STORE, TACURONG_DOOR);
    await expect(assignRider("ERR-ZONE")).rejects.toThrow(/at capacity/);
    expect(state.claims).toEqual([TACURONG_RIDER]);
  });

  it("queues only the Banga rider for a Banga errand", async () => {
    state.errand = errandAt(BANGA_STORE, BANGA_DOOR);
    await expect(assignRider("ERR-ZONE")).rejects.toThrow(/at capacity/);
    expect(state.claims).toEqual([BANGA_RIDER]);
  });

  it("leaves out a rider whose fix is too old to say where they are", async () => {
    // record() ignores a fix older than the one it holds, so start over.
    riderPositionStore.clear(TACURONG_RIDER);
    fixAt(TACURONG_RIDER, { latitude: 6.69, longitude: 124.68 }, 5 * 60 * 1000);
    state.errand = errandAt(TACURONG_STORE, TACURONG_DOOR);
    await expect(assignRider("ERR-ZONE")).rejects.toThrow(
      "No rider is currently available in the Tacurong City service area. 3 available riders are elsewhere or without a recent location."
    );
    expect(state.claims).toEqual([]);
  });

  it("says which zone has no rider instead of falling back to the other zone", async () => {
    state.riders = [rider(BANGA_RIDER)];
    state.errand = errandAt(TACURONG_STORE, TACURONG_DOOR);
    await expect(assignRider("ERR-ZONE")).rejects.toThrow(
      "No rider is currently available in the Tacurong City service area. 1 available rider is elsewhere or without a recent location."
    );
    expect(state.claims).toEqual([]);
  });

  it("refuses a dispatcher's pick of a rider working in the other zone", async () => {
    state.errand = errandAt(TACURONG_STORE, TACURONG_DOOR);
    await expect(assignRider("ERR-ZONE", BANGA_RIDER)).rejects.toThrow(
      "This rider is working in Banga and this errand is in Tacurong City."
    );
    expect(state.claims).toEqual([]);
  });

  it("leaves a dispatcher's pick of a rider with no fix to the dispatcher", async () => {
    state.errand = errandAt(TACURONG_STORE, TACURONG_DOOR);
    await expect(assignRider("ERR-ZONE", NO_FIX_RIDER)).rejects.toThrow(/already carrying/);
    expect(state.claims).toEqual([NO_FIX_RIDER]);
  });
});
