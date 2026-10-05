import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The provider reads its base URL at import time.
vi.mock("../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env.js")>()),
  OSRM_BASE_URL: "http://osrm.test",
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import { OsrmRoutingProvider, originHintQuery } from "../src/lib/routing/osrmProvider.js";
import { originHintFor, ORIGIN_HINT_MIN_SPEED_MPS } from "../src/services/routingService.js";

const A = { latitude: 6.6833, longitude: 124.6745 };
const B = { latitude: 6.6901, longitude: 124.6801 };
const C = { latitude: 6.6950, longitude: 124.6850 };

const OK_ROUTE = {
  code: "Ok",
  routes: [
    {
      distance: 900,
      duration: 120,
      geometry: "",
      legs: [{ distance: 900, duration: 120, steps: [] }],
    },
  ],
};

describe("originHintFor", () => {
  it("sends nothing without a heading, or below riding speed", () => {
    expect(originHintFor({ speedMps: 8 })).toBeUndefined();
    expect(originHintFor({ heading: 90 })).toBeUndefined();
    expect(originHintFor({ heading: 90, speedMps: ORIGIN_HINT_MIN_SPEED_MPS - 0.1 })).toBeUndefined();
  });

  it("points the route the way the rider is riding, within 45 degrees", () => {
    expect(originHintFor({ heading: 270, speedMps: 6, accuracyMeters: 8 })).toEqual({
      bearingDeg: 270,
      bearingRange: 45,
      radiusMeters: 25,
    });
  });

  it("looks as far as twice the fix's accuracy, between 25 and 60 m", () => {
    expect(originHintFor({ heading: 10, speedMps: 6, accuracyMeters: 20 })!.radiusMeters).toBe(40);
    expect(originHintFor({ heading: 10, speedMps: 6, accuracyMeters: 45 })!.radiusMeters).toBe(60);
    expect(originHintFor({ heading: 10, speedMps: 6 })!.radiusMeters).toBe(40);
  });
});

describe("originHintQuery", () => {
  it("constrains the first coordinate only, one entry per coordinate", () => {
    expect(originHintQuery({ bearingDeg: 359.6, bearingRange: 45, radiusMeters: 30.4 }, 3)).toBe(
      "&bearings=0,45;;&radiuses=30;;"
    );
    expect(originHintQuery(undefined, 3)).toBe("");
  });
});

describe("OsrmRoutingProvider with an origin hint", () => {
  const fetchMock = vi.fn();
  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => fetchMock.mockReset());

  const respond = (body: unknown) =>
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));

  const hint = { bearingDeg: 90, bearingRange: 45, radiusMeters: 30 };

  it("asks for the route starting on a road going the rider's way", async () => {
    respond(OK_ROUTE);
    const route = await new OsrmRoutingProvider().route([A, B, C], { origin: hint });
    expect(route).not.toBeNull();
    expect(urls()).toHaveLength(1);
    expect(urls()[0]).toContain("&bearings=90,45;;&radiuses=30;;");
  });

  it("routes as before when no road going that way is close enough", async () => {
    respond({ code: "NoSegment", message: "Could not find a matching segment" });
    respond(OK_ROUTE);
    const route = await new OsrmRoutingProvider().route([A, B], { origin: hint });
    expect(route).not.toBeNull();
    expect(urls()).toHaveLength(2);
    expect(urls()[1]).not.toContain("bearings");
  });

  it("sends no hint when there is none", async () => {
    respond(OK_ROUTE);
    await new OsrmRoutingProvider().route([A, B]);
    expect(urls()[0]).not.toContain("bearings");
  });

  it("snaps onto the road going the rider's way, else the nearest road", async () => {
    respond({ code: "NoSegment" });
    respond({ code: "Ok", waypoints: [{ location: [A.longitude, A.latitude], distance: 4 }] });
    const snapped = await new OsrmRoutingProvider().snap(A, hint);
    expect(snapped).toEqual(A);
    expect(urls()[0]).toContain("/nearest/v1/driving/");
    expect(urls()[0]).toContain("&bearings=90,45&radiuses=30");
    expect(urls()[1]).not.toContain("bearings");
  });
});
