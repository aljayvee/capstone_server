import { beforeEach, describe, expect, it, vi } from "vitest";

const { routeWith } = vi.hoisted(() => ({ routeWith: vi.fn() }));
vi.mock("../src/lib/routing/resilientRoutingService.js", () => ({ routeWith }));

import {
  bestRoute,
  midpointAlong,
  pickFastest,
  viaPointsAlong,
  withTotalDuration,
} from "../src/lib/routing/bestRoute.js";
import type { RouteResult, RouteStep } from "../src/lib/routing/types.js";

const A = { latitude: 6.4117, longitude: 124.769 }; // Banga
const B = { latitude: 6.6961, longitude: 124.6728 }; // Tacurong

function step(distanceMeters: number, durationSeconds: number, from: number): RouteStep {
  return {
    instruction: "Continue",
    streetName: "",
    maneuverType: "continue",
    distanceMeters,
    durationSeconds,
    location: { latitude: 6.4 + from, longitude: 124.7 },
    coordinates: [
      { latitude: 6.4 + from, longitude: 124.7 },
      { latitude: 6.4 + from + 0.01, longitude: 124.7 },
    ],
  };
}

function route(provider: "osrm" | "google", km: number, minutes: number, extra: Partial<RouteResult> = {}): RouteResult {
  const steps = [step(km * 400, minutes * 24, 0), step(km * 600, minutes * 36, 0.01)];
  return {
    distanceMeters: km * 1000,
    durationSeconds: minutes * 60,
    coordinates: [A, B],
    legs: [{ distanceMeters: km * 1000, durationSeconds: minutes * 60, coordinates: [A, B], steps }],
    steps,
    provider,
    degraded: false,
    ...extra,
  };
}

describe("pickFastest", () => {
  it("takes the lower ETA", () => {
    expect(pickFastest([route("google", 53.1, 60), route("osrm", 44.8, 54)])!.provider).toBe("osrm");
    expect(pickFastest([route("osrm", 44.8, 54), route("google", 45.1, 48)])!.provider).toBe("google");
  });

  it("takes the shorter road when the ETAs are within a minute", () => {
    expect(pickFastest([route("osrm", 12, 20), route("google", 10, 20.5)])!.provider).toBe("google");
  });

  it("uses the time gap, not the distance, once the ETAs really differ", () => {
    // Google's road is longer but clearly quicker (a highway round the town).
    expect(pickFastest([route("osrm", 10, 30), route("google", 14, 22)])!.provider).toBe("google");
  });

  it("never picks a straight-line guess, and survives a missing engine", () => {
    expect(pickFastest([route("osrm", 44.8, 54), route("google", 30, 10, { degraded: true })])!.provider).toBe("osrm");
    expect(pickFastest([null, route("google", 45, 55)])!.provider).toBe("google");
    expect(pickFastest([null, undefined])).toBeNull();
  });
});

describe("viaPointsAlong", () => {
  it("takes the middle of the longest stretches, in route order, clear of the ends", () => {
    const vias = viaPointsAlong(route("osrm", 44.8, 54));
    expect(vias).toHaveLength(2);
    expect(vias[0].latitude).toBeLessThan(vias[1].latitude);
  });

  it("skips stretches too short to pin a road down", () => {
    const short = route("osrm", 0.2, 1);
    expect(viaPointsAlong(short)).toHaveLength(0);
  });

  it("finds the point halfway along a line", () => {
    const mid = midpointAlong([
      { latitude: 6.4, longitude: 124.7 },
      { latitude: 6.42, longitude: 124.7 },
    ])!;
    expect(mid.latitude).toBeCloseTo(6.41, 6);
  });
});

describe("withTotalDuration", () => {
  it("scales every step so they add up to the ETA that won", () => {
    const scaled = withTotalDuration(route("google", 45, 60), 54 * 60);
    expect(scaled.durationSeconds).toBe(3240);
    const sum = scaled.steps.reduce((total, s) => total + s.durationSeconds, 0);
    expect(Math.abs(sum - 3240)).toBeLessThanOrEqual(1);
    expect(scaled.legs[0].durationSeconds).toBe(3240);
  });
});

describe("bestRoute", () => {
  beforeEach(() => routeWith.mockReset());

  const answer = (osrm: RouteResult | null, google: RouteResult | null, redrawn: RouteResult | null = null) =>
    routeWith.mockImplementation(async (name: string, _points: unknown, options?: { passThrough?: boolean }) => {
      if (options?.passThrough) return redrawn;
      return name === "osrm" ? osrm : google;
    });

  it("draws the winner as it is when it is the map's own engine", async () => {
    answer(route("osrm", 44.8, 54), route("google", 53.1, 60));
    const best = await bestRoute([A, B], "osrm");
    expect(best!.route.provider).toBe("osrm");
    expect(best!.selection).toMatchObject({ chosen: "osrm", drawnWith: "osrm" });
    expect(best!.selection.candidates).toHaveLength(2);
  });

  it("redraws OSRM's faster path on Google's roads for the Google map, with OSRM's ETA", async () => {
    answer(route("osrm", 44.8, 54), route("google", 53.1, 60), route("google", 45.3, 58));
    const best = await bestRoute([A, B], "google");
    expect(best!.selection).toMatchObject({ chosen: "osrm", drawnWith: "google" });
    expect(best!.route.provider).toBe("google");
    expect(best!.route.durationSeconds).toBe(54 * 60);
    // The redraw was asked to pass along the winner's roads.
    const redrawCall = routeWith.mock.calls.find((call) => call[2]?.passThrough);
    expect(redrawCall![0]).toBe("google");
    expect(redrawCall![1].length).toBeGreaterThan(2);
  });

  it("draws the winner on its own roads when the redraw took a different road", async () => {
    answer(route("osrm", 44.8, 54), route("google", 53.1, 60), route("google", 52, 59));
    const best = await bestRoute([A, B], "google");
    expect(best!.route.provider).toBe("osrm");
    expect(best!.selection).toMatchObject({ chosen: "osrm", drawnWith: "osrm" });
  });

  it("uses the map's own route with no extra request when it is the same path", async () => {
    answer(route("osrm", 44.8, 50), route("google", 44.9, 56));
    const best = await bestRoute([A, B], "google");
    expect(best!.route.provider).toBe("google");
    expect(best!.route.durationSeconds).toBe(50 * 60);
    expect(routeWith.mock.calls.some((call) => call[2]?.passThrough)).toBe(false);
  });

  it("refuses a redraw of the same length that runs along a different road", async () => {
    // Same 44.8 km, but through a point ~5 km east of the winner's road.
    const detour = route("google", 44.8, 58, {
      coordinates: [A, { latitude: 6.55, longitude: 124.77 }, B],
    });
    answer(route("osrm", 44.8, 54), route("google", 53.1, 60), detour);
    const best = await bestRoute([A, B], "google");
    expect(best!.selection).toMatchObject({ chosen: "osrm", drawnWith: "osrm" });
    expect(best!.route.provider).toBe("osrm");
  });

  it("keeps the path that already won when the rider only switched maps, asking only that engine", async () => {
    answer(route("osrm", 44.8, 54), route("google", 40, 30), route("google", 45.3, 58));
    const best = await bestRoute([A, B], "google", { keep: "osrm" });
    // Google would win a fresh comparison (30 min), but the path is kept.
    expect(best!.selection.chosen).toBe("osrm");
    const plainCalls = routeWith.mock.calls.filter((call) => !call[2]?.passThrough).map((call) => call[0]);
    expect(plainCalls).toEqual(["osrm"]);
  });

  it("compares afresh when the kept engine has no answer", async () => {
    answer(null, route("google", 45, 55));
    const best = await bestRoute([A, B], "osrm", { keep: "osrm" });
    expect(best!.selection.chosen).toBe("google");
  });

  it("draws the winner on its own roads when no map is named, so the app shows that map", async () => {
    answer(route("osrm", 44.8, 58), route("google", 45.1, 50));
    const best = await bestRoute([A, B], undefined);
    expect(best!.selection).toMatchObject({ chosen: "google", drawnWith: "google" });
    expect(best!.route.provider).toBe("google");
    // No redraw is ever asked for.
    expect(routeWith.mock.calls.some((call) => call[2]?.passThrough)).toBe(false);
  });

  it("works with one engine down", async () => {
    answer(route("osrm", 44.8, 54), null);
    const best = await bestRoute([A, B], "google");
    expect(best!.selection.chosen).toBe("osrm");
    expect(best!.selection.candidates).toHaveLength(1);
  });

  it("has no answer when neither engine has one", async () => {
    answer(null, null);
    expect(await bestRoute([A, B], "osrm")).toBeNull();
  });
});
