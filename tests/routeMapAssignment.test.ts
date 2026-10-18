import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { osrmRoute, googleRoute, routePickCreate, errandFindUnique, mode } = vi.hoisted(() => ({
  osrmRoute: vi.fn(),
  googleRoute: vi.fn(),
  routePickCreate: vi.fn(),
  errandFindUnique: vi.fn(),
  mode: { value: "rider_day" as "rider_day" | "off" },
}));

vi.mock("../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env.js")>()),
  ROUTING_PROVIDER_ORDER: ["osrm", "google", "haversine"],
  get ROUTE_MAP_ASSIGNMENT() {
    return mode.value;
  },
}));
vi.mock("../src/lib/routing/osrmProvider.js", () => ({
  OsrmRoutingProvider: class {
    readonly name = "osrm";
    isConfigured = () => true;
    route = (points: unknown) => osrmRoute(points);
    snap = async () => null;
  },
}));
vi.mock("../src/lib/routing/googleProvider.js", () => ({
  GoogleRoutingProvider: class {
    readonly name = "google";
    isConfigured = () => true;
    route = (points: unknown) => googleRoute(points);
    snap = async () => null;
  },
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { errand: { findUnique: errandFindUnique }, routePick: { create: routePickCreate } },
}));

import { assignedMapFor, manilaDay, manilaDayNumber } from "../src/lib/routing/mapAssignment.js";
import { getDirections } from "../src/services/routingService.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Noon in Manila on 2026-10-18.
const NOON = Date.parse("2026-10-18T04:00:00Z");

const ROAD = [
  { latitude: 6.69, longitude: 124.67 },
  { latitude: 6.7, longitude: 124.68 },
];
const route = (provider: string, durationSeconds: number, coordinates = ROAD) => ({
  distanceMeters: 1000,
  durationSeconds,
  coordinates,
  legs: [],
  steps: [],
  provider,
  degraded: false,
});

let lat = 6.5;
const trip = () => {
  // A fresh pair of points per test, so the route cache never answers.
  lat += 0.001;
  return [
    { latitude: lat, longitude: 124.67 },
    { latitude: lat + 0.01, longitude: 124.68 },
  ] as const;
};

/** The first rider id given `map` on the day of `now`. */
const riderOn = (map: "osrm" | "google", now = NOON) => {
  for (let id = 1; id < 100; id++) if (assignedMapFor(id, now) === map) return id;
  throw new Error(`no rider on ${map}`);
};

describe("the map a rider is given", () => {
  it("is the same all day and the other one the next day", () => {
    for (let id = 1; id <= 50; id++) {
      expect(assignedMapFor(id, NOON + 5 * 60 * 60 * 1000)).toBe(assignedMapFor(id, NOON));
      expect(assignedMapFor(id, NOON + DAY_MS)).not.toBe(assignedMapFor(id, NOON));
    }
  });

  it("turns over at midnight in Manila, not in UTC", () => {
    const lastMoment = Date.parse("2026-10-18T15:59:59.999Z");
    const nextDay = Date.parse("2026-10-18T16:00:00Z");
    expect(manilaDayNumber(lastMoment)).toBe(manilaDayNumber(NOON));
    expect(manilaDayNumber(nextDay)).toBe(manilaDayNumber(NOON) + 1);
    expect(manilaDay(nextDay).toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(assignedMapFor(7, nextDay)).not.toBe(assignedMapFor(7, lastMoment));
  });

  it("splits a fleet about evenly on any one day", () => {
    const share = (ids: number[]) => ids.filter((id) => assignedMapFor(id, NOON) === "osrm").length / ids.length;
    const all = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(share(all)).toBeGreaterThan(0.4);
    expect(share(all)).toBeLessThan(0.6);
    // Hashed, not id parity: riders whose ids are all even still split.
    const even = all.map((id) => id * 2);
    expect(share(even)).toBeGreaterThan(0.4);
    expect(share(even)).toBeLessThan(0.6);
  });
});

describe("getDirections for a rider", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
    mode.value = "rider_day";
    // OSRM's path is faster by nine minutes: well outside the tie band.
    osrmRoute.mockReset().mockResolvedValue(route("osrm", 60));
    googleRoute.mockReset().mockResolvedValue(route("google", 600));
    routePickCreate.mockReset().mockResolvedValue({});
    errandFindUnique.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws the fastest path on today's map when the app shows none yet", async () => {
    const riderId = riderOn("google");
    const [origin, destination] = trip();
    const r = await getDirections(origin, destination, [], { choose: "fastest", caller: { id: riderId, role: "RIDER" } });
    // OSRM's path still wins; it is drawn on Google's roads.
    expect(r.selection).toMatchObject({ chosen: "osrm", drawnWith: "google" });
    // OSRM's ETA, not Google's slower one.
    expect(r.durationSeconds).toBe(60);
  });

  it("gives the other half of the fleet the other map", async () => {
    const riderId = riderOn("osrm");
    osrmRoute.mockResolvedValue(route("osrm", 600));
    googleRoute.mockResolvedValue(route("google", 60));
    const [origin, destination] = trip();
    const r = await getDirections(origin, destination, [], { choose: "fastest", caller: { id: riderId, role: "RIDER" } });
    expect(r.selection).toMatchObject({ chosen: "google", drawnWith: "osrm" });
  });

  it("keeps the map the app already shows", async () => {
    const riderId = riderOn("google");
    const [origin, destination] = trip();
    const r = await getDirections(origin, destination, [], {
      choose: "fastest",
      prefer: "osrm",
      caller: { id: riderId, role: "RIDER" },
    });
    expect(r.selection?.drawnWith).toBe("osrm");
    await vi.waitFor(() => expect(routePickCreate).toHaveBeenCalled());
    expect(routePickCreate.mock.calls[0][0].data).toMatchObject({ mapSource: "app", mapAsked: "osrm" });
  });

  it("draws on the winner's own roads when the path cannot follow the assigned map", async () => {
    const riderId = riderOn("google");
    // Google's road is a block away: not the same path, and nothing to redraw it through.
    googleRoute.mockResolvedValue(
      route("google", 600, [
        { latitude: 6.6, longitude: 124.6 },
        { latitude: 6.61, longitude: 124.61 },
      ])
    );
    const [origin, destination] = trip();
    const r = await getDirections(origin, destination, [], { choose: "fastest", caller: { id: riderId, role: "RIDER" } });
    expect(r.selection).toMatchObject({ chosen: "osrm", drawnWith: "osrm" });
    await vi.waitFor(() => expect(routePickCreate).toHaveBeenCalled());
    // Recorded as asked for Google and drawn on OSRM: the fallback is countable.
    expect(routePickCreate.mock.calls[0][0].data).toMatchObject({ mapAsked: "google", drawnWith: "osrm" });
  });

  it("uses the winner's map, as before, with assignment off", async () => {
    mode.value = "off";
    const riderId = riderOn("google");
    const [origin, destination] = trip();
    const r = await getDirections(origin, destination, [], { choose: "fastest", caller: { id: riderId, role: "RIDER" } });
    expect(r.selection).toMatchObject({ chosen: "osrm", drawnWith: "osrm" });
    await vi.waitFor(() => expect(routePickCreate).toHaveBeenCalled());
    expect(routePickCreate.mock.calls[0][0].data).toMatchObject({ mapSource: "winner", mapAsked: null });
  });

  it("records the decision with both engines' answers", async () => {
    const riderId = riderOn("google");
    const [origin, destination] = trip();
    await getDirections(origin, destination, [], { choose: "fastest", caller: { id: riderId, role: "RIDER" } });
    await vi.waitFor(() => expect(routePickCreate).toHaveBeenCalledTimes(1));
    expect(routePickCreate.mock.calls[0][0].data).toEqual({
      riderId,
      day: new Date("2026-10-18T00:00:00Z"),
      mapSource: "assigned",
      mapAsked: "google",
      chosen: "osrm",
      drawnWith: "google",
      osrmDurationSeconds: 60,
      osrmDistanceMeters: 1000,
      googleDurationSeconds: 600,
      googleDistanceMeters: 1000,
      createdAt: new Date(NOON),
    });
  });

  it("records an engine that gave no answer as empty", async () => {
    const riderId = riderOn("osrm");
    googleRoute.mockResolvedValue(null);
    const [origin, destination] = trip();
    await getDirections(origin, destination, [], { choose: "fastest", caller: { id: riderId, role: "RIDER" } });
    await vi.waitFor(() => expect(routePickCreate).toHaveBeenCalled());
    expect(routePickCreate.mock.calls[0][0].data).toMatchObject({
      googleDurationSeconds: null,
      googleDistanceMeters: null,
      osrmDurationSeconds: 60,
    });
  });

  it("still answers the rider when the record cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    routePickCreate.mockImplementation(() => {
      throw new Error("Table 'route_picks' doesn't exist");
    });
    const [origin, destination] = trip();
    const r = await getDirections(origin, destination, [], { choose: "fastest", caller: { id: 5, role: "RIDER" } });
    expect(r.selection).not.toBeNull();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("route_picks")));
    warn.mockRestore();
  });

  it("assigns nothing and records nothing for a customer", async () => {
    const [origin, destination] = trip();
    const r = await getDirections(origin, destination, [], { choose: "fastest", caller: { id: 9, role: "CUSTOMER" } });
    expect(r.selection).toMatchObject({ chosen: "osrm", drawnWith: "osrm" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(routePickCreate).not.toHaveBeenCalled();
  });
});
