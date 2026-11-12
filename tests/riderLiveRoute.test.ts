import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRiderRoutes,
  isFollowing,
  metresFromPath,
  rememberRiderRoute,
  riderRouteFor,
  RIDER_ROUTE_MAX_AGE_MS,
} from "../src/lib/routing/riderLiveRoute.js";

// A road running due north from the rider to the door, about 1.1 km.
const START = { latitude: 6.69, longitude: 124.67 };
const DOOR = { latitude: 6.7, longitude: 124.67 };
const ROAD = [START, { latitude: 6.695, longitude: 124.67 }, DOOR];

/** `metres` east of a point on the road. One degree of longitude here is about 110.6 km. */
const eastOf = (point: { latitude: number; longitude: number }, metres: number) => ({
  latitude: point.latitude,
  longitude: point.longitude + metres / 110_574,
});

const input = (overrides: Record<string, unknown> = {}) => ({
  riderId: 7,
  origin: START,
  target: DOOR,
  coordinates: ROAD,
  distanceMeters: 1100,
  durationSeconds: 180,
  lineEngine: "osrm",
  ...overrides,
});

beforeEach(() => __resetRiderRoutes());

describe("metresFromPath", () => {
  it("measures to the nearest part of the line, not the nearest corner", () => {
    const midway = { latitude: 6.6925, longitude: 124.67 };
    expect(metresFromPath(eastOf(midway, 40), ROAD)).toBeCloseTo(40, 0);
    expect(metresFromPath(midway, ROAD)).toBeLessThan(0.5);
  });

  it("has no distance to offer for an empty line", () => {
    expect(metresFromPath(START, [])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("rememberRiderRoute", () => {
  it("keeps the first line without calling it a reroute", () => {
    const { route, rerouted } = rememberRiderRoute(input(), 1_000);

    expect(rerouted).toBe(false);
    expect(route.reroutedAt).toBeNull();
    expect(riderRouteFor(7, 1_000)).toBe(route);
  });

  it("calls it a reroute when the rider asks again from off the line, to the same stop", () => {
    rememberRiderRoute(input(), 1_000);
    const side = eastOf({ latitude: 6.693, longitude: 124.67 }, 60);

    const { route, rerouted } = rememberRiderRoute(input({ origin: side, coordinates: [side, DOOR] }), 61_000);

    expect(rerouted).toBe(true);
    expect(route.reroutedAt).toBe(61_000);
    expect(route.version).toBe(2);
  });

  it("does not call it a reroute when the app asks again from on the line", () => {
    rememberRiderRoute(input(), 1_000);
    const onRoad = eastOf({ latitude: 6.693, longitude: 124.67 }, 8);

    const { route, rerouted } = rememberRiderRoute(input({ origin: onRoad }), 61_000);

    expect(rerouted).toBe(false);
    expect(route.reroutedAt).toBeNull();
  });

  it("does not call a change of map a reroute, and keeps when the route was last left", () => {
    rememberRiderRoute(input(), 1_000);
    const side = eastOf({ latitude: 6.693, longitude: 124.67 }, 60);
    rememberRiderRoute(input({ origin: side, coordinates: [side, DOOR] }), 61_000);

    const far = eastOf({ latitude: 6.696, longitude: 124.67 }, 90);
    const { route, rerouted } = rememberRiderRoute(
      input({ origin: far, coordinates: [far, DOOR], lineEngine: "google", sameRoadRedrawn: true }),
      90_000
    );

    expect(rerouted).toBe(false);
    expect(route.reroutedAt).toBe(61_000);
    expect(route.lineEngine).toBe("google");
  });

  it("starts clean for the next stop", () => {
    rememberRiderRoute(input(), 1_000);
    const side = eastOf({ latitude: 6.693, longitude: 124.67 }, 60);
    rememberRiderRoute(input({ origin: side, coordinates: [side, DOOR] }), 61_000);

    const nextStop = { latitude: 6.71, longitude: 124.68 };
    const { route, rerouted } = rememberRiderRoute(
      input({ origin: eastOf(DOOR, 80), target: nextStop, coordinates: [DOOR, nextStop] }),
      120_000
    );

    expect(rerouted).toBe(false);
    expect(route.reroutedAt).toBeNull();
  });

  it("keeps one line per rider", () => {
    rememberRiderRoute(input(), 1_000);
    rememberRiderRoute(input({ riderId: 8, lineEngine: "google" }), 1_000);

    expect(riderRouteFor(7, 1_000)?.lineEngine).toBe("osrm");
    expect(riderRouteFor(8, 1_000)?.lineEngine).toBe("google");
  });
});

describe("riderRouteFor", () => {
  it("stops offering a line once the errand is long over", () => {
    rememberRiderRoute(input(), 1_000);

    expect(riderRouteFor(7, 1_000 + RIDER_ROUTE_MAX_AGE_MS)).not.toBeNull();
    expect(riderRouteFor(7, 1_001 + RIDER_ROUTE_MAX_AGE_MS)).toBeNull();
  });
});

describe("isFollowing", () => {
  it("is true beside the road and false a few blocks away", () => {
    const { route } = rememberRiderRoute(input(), 1_000);
    const midway = { latitude: 6.6925, longitude: 124.67 };

    expect(isFollowing(route, eastOf(midway, 100))).toBe(true);
    expect(isFollowing(route, eastOf(midway, 400))).toBe(false);
  });
});
