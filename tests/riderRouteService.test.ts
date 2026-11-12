import { beforeEach, describe, expect, it, vi } from "vitest";

// Records every emit with the rooms it was addressed to.
const { emitted, chain, findMany, findUnique, count, canSubscribeToErrand } = vi.hoisted(() => {
  const emitted: Array<{ rooms: string[]; event: string; payload: any }> = [];
  const chain = (roomsSoFar: string[]): any => ({
    to: (room: string) => chain([...roomsSoFar, room]),
    emit: (event: string, payload: unknown) => emitted.push({ rooms: roomsSoFar, event, payload }),
  });
  return {
    emitted,
    chain,
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    canSubscribeToErrand: vi.fn(),
  };
});

vi.mock("../src/lib/socket.js", () => ({
  io: { to: (room: string) => chain([room]) },
  rooms: {
    role: (role: string) => `role:${role}`,
    errand: (id: string) => `errand:${id}`,
    customer: (id: number) => `customer:${id}`,
  },
  canSubscribeToErrand,
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { errand: { findMany, findUnique, count } } }));

import { recordRiderRoute, riderRouteForViewer } from "../src/services/riderRouteService.js";
import { __resetRiderRoutes } from "../src/lib/routing/riderLiveRoute.js";
import * as riderPositionStore from "../src/lib/riderPositionStore.js";

const START = { latitude: 6.69, longitude: 124.67 };
const DOOR = { latitude: 6.7, longitude: 124.67 };
const STORE = { latitude: 6.68, longitude: 124.66 };
const ROAD = [START, { latitude: 6.695, longitude: 124.67 }, DOOR];

const RIDER = { id: 7, role: "RIDER" };
const CUSTOMER = { id: 42, role: "CUSTOMER" };
const DISPATCHER = { id: 3, role: "DISPATCHER" };

const answer = (overrides: Record<string, unknown> = {}) => ({
  coordinates: ROAD,
  distanceMeters: 1100,
  durationSeconds: 180,
  provider: "osrm",
  degraded: false,
  selection: null,
  ...overrides,
});

const errandAtDoor = { id: "e-1", customerId: 42, deliveryLatitude: DOOR.latitude, deliveryLongitude: DOOR.longitude };

beforeEach(() => {
  emitted.length = 0;
  __resetRiderRoutes();
  riderPositionStore.clear(7);
  findMany.mockReset().mockResolvedValue([]);
  findUnique.mockReset().mockResolvedValue(null);
  count.mockReset().mockResolvedValue(1);
  canSubscribeToErrand.mockReset().mockResolvedValue(true);
});

describe("recordRiderRoute", () => {
  it("tells staff, and the customer whose door the line ends at", async () => {
    findMany.mockResolvedValue([errandAtDoor]);

    await recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer());

    expect(emitted).toHaveLength(2);
    expect(emitted[0].rooms).toEqual(["role:DISPATCHER", "role:OWNER"]);
    expect(emitted[0].payload).toMatchObject({ riderId: 7, rerouted: false, errandIds: ["e-1"] });
    expect(emitted[1].rooms).toEqual(["errand:e-1", "customer:42"]);
    expect(emitted[1].event).toBe("rider:route");
  });

  it("tells no customer while the rider is heading to a store", async () => {
    findMany.mockResolvedValue([errandAtDoor]);

    await recordRiderRoute(RIDER, { origin: START, destination: STORE }, answer({ coordinates: [START, STORE] }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].rooms).toEqual(["role:DISPATCHER", "role:OWNER"]);
    expect(emitted[0].payload.errandIds).toEqual([]);
  });

  it("names only a customer's own errand when two share one address", async () => {
    findMany.mockResolvedValue([errandAtDoor, { ...errandAtDoor, id: "e-2", customerId: 43 }]);

    await recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer());

    const toCustomers = emitted.slice(1);
    expect(toCustomers.map((e) => e.rooms)).toEqual([
      ["errand:e-1", "customer:42"],
      ["errand:e-2", "customer:43"],
    ]);
    expect(toCustomers.map((e) => e.payload.errandIds)).toEqual([["e-1"], ["e-2"]]);
  });

  it("flags the line that replaces one the rider left", async () => {
    await recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer());
    const side = { latitude: 6.693, longitude: 124.6706 };

    await recordRiderRoute(RIDER, { origin: side, destination: DOOR }, answer({ coordinates: [side, DOOR] }));

    expect(emitted[1].payload).toMatchObject({ rerouted: true, version: 2 });
    expect(emitted[1].payload.reroutedAt).toEqual(expect.any(Number));
  });

  it("keeps nothing for a straight-line guess, or for anyone who is not a rider", async () => {
    await recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer({ degraded: true }));
    await recordRiderRoute(CUSTOMER, { origin: START, destination: DOOR }, answer());
    await recordRiderRoute(undefined, { origin: START, destination: DOOR }, answer());

    expect(emitted).toHaveLength(0);
    expect((await riderRouteForViewer(DISPATCHER, { riderId: 7 })).route).toBeNull();
  });

  it("ignores a route that starts nowhere near the rider", async () => {
    riderPositionStore.record(7, {
      point: { latitude: 6.6, longitude: 124.6 },
      recordedAt: Date.now(),
      accuracyMeters: 10,
      headingDeg: null,
    });

    await recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer());

    expect(emitted).toHaveLength(0);
  });

  it("never throws when the errand lookup fails, and staff are still told", async () => {
    findMany.mockRejectedValue(new Error("database is away"));

    await expect(recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer())).resolves.toBeUndefined();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].rooms).toEqual(["role:DISPATCHER", "role:OWNER"]);
  });
});

describe("riderRouteForViewer", () => {
  const trackedErrand = {
    riderId: 7,
    status: "IN_TRANSIT",
    deliveryLatitude: DOOR.latitude,
    deliveryLongitude: DOOR.longitude,
  };

  it("gives the customer the line that ends at their door", async () => {
    await recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer());
    findUnique.mockResolvedValue(trackedErrand);

    const { route } = await riderRouteForViewer(CUSTOMER, { errandId: "e-1" });

    expect(route).toMatchObject({ riderId: 7, lineEngine: "osrm", distanceMeters: 1100 });
    expect(route?.coordinates).toEqual(ROAD);
  });

  it("gives the customer nothing while the rider is heading to a store, but staff the line", async () => {
    await recordRiderRoute(RIDER, { origin: START, destination: STORE }, answer({ coordinates: [START, STORE] }));
    findUnique.mockResolvedValue(trackedErrand);

    expect((await riderRouteForViewer(CUSTOMER, { errandId: "e-1" })).route).toBeNull();
    expect((await riderRouteForViewer(DISPATCHER, { errandId: "e-1" })).route).not.toBeNull();
    expect((await riderRouteForViewer(DISPATCHER, { riderId: 7 })).route).not.toBeNull();
  });

  it("refuses an errand the caller may not watch", async () => {
    canSubscribeToErrand.mockResolvedValue(false);

    await expect(riderRouteForViewer(CUSTOMER, { errandId: "e-9" })).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a customer asking by rider", async () => {
    await expect(riderRouteForViewer(CUSTOMER, { riderId: 7 })).rejects.toMatchObject({ status: 403 });
  });

  it("gives nothing once the errand is no longer being delivered", async () => {
    await recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer());
    findUnique.mockResolvedValue({ ...trackedErrand, status: "DELIVERED" });
    count.mockResolvedValue(0);

    expect((await riderRouteForViewer(CUSTOMER, { errandId: "e-1" })).route).toBeNull();
    expect((await riderRouteForViewer(DISPATCHER, { riderId: 7 })).route).toBeNull();
  });

  it("gives nothing when the rider is blocks away from the line kept for them", async () => {
    await recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer());
    findUnique.mockResolvedValue(trackedErrand);
    riderPositionStore.record(7, {
      point: { latitude: 6.6925, longitude: 124.675 },
      recordedAt: Date.now(),
      accuracyMeters: 10,
      headingDeg: null,
    });

    expect((await riderRouteForViewer(CUSTOMER, { errandId: "e-1" })).route).toBeNull();
  });

  it("does not resend a line the caller already holds", async () => {
    await recordRiderRoute(RIDER, { origin: START, destination: DOOR }, answer());
    findUnique.mockResolvedValue(trackedErrand);
    const first = await riderRouteForViewer(CUSTOMER, { errandId: "e-1" });

    const again = await riderRouteForViewer(CUSTOMER, { errandId: "e-1", since: first.route?.version });

    expect(again).toEqual({ route: null, unchanged: true });
  });
});
