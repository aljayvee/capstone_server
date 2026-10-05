import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The provider reads its base URL at import time.
vi.mock("../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env.js")>()),
  OSRM_BASE_URL: "http://osrm.test",
  ROUTE_MAX_SPEED_KMH: 60,
}));

import { cappedDurationSeconds } from "../src/lib/routing/speedCap.js";
import { OsrmRoutingProvider } from "../src/lib/routing/osrmProvider.js";

const KMH_60 = 60 / 3.6;

describe("cappedDurationSeconds", () => {
  it("slows a stretch the engine priced faster than the cap", () => {
    // 12.2 km at OSRM's 85 km/h is 517 s; at 60 km/h it is 732 s.
    expect(cappedDurationSeconds(12_200, 517, 60)).toBeCloseTo(12_200 / KMH_60, 5);
  });

  it("leaves a stretch already slower than the cap untouched", () => {
    expect(cappedDurationSeconds(1_100, 128, 60)).toBe(128);
  });

  it("does nothing when switched off or given no distance", () => {
    expect(cappedDurationSeconds(12_200, 517, 0)).toBe(517);
    expect(cappedDurationSeconds(0, 30, 60)).toBe(30);
  });
});

describe("OsrmRoutingProvider durations", () => {
  const fetchMock = vi.fn();
  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => fetchMock.mockReset());

  const respond = (body: unknown) =>
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });

  it("caps each road stretch and sums legs and route from the capped steps", async () => {
    respond({
      code: "Ok",
      routes: [
        {
          distance: 13_300,
          duration: 645,
          geometry: "",
          legs: [
            {
              distance: 13_300,
              duration: 645,
              steps: [
                // Highway at 85 km/h: capped.
                { distance: 12_200, duration: 517, name: "Isulan-Surallah Road", maneuver: { type: "depart", location: [124.7, 6.4] } },
                // Town street at 31 km/h: untouched.
                { distance: 1_100, duration: 128, name: "Ledesma Street", maneuver: { type: "arrive", location: [124.67, 6.69] } },
              ],
            },
          ],
        },
      ],
    });

    const result = await new OsrmRoutingProvider().route([
      { latitude: 6.4, longitude: 124.7 },
      { latitude: 6.69, longitude: 124.67 },
    ]);

    expect(result).not.toBeNull();
    expect(result!.distanceMeters).toBe(13_300);
    expect(result!.legs[0].steps.map((s) => s.durationSeconds)).toEqual([Math.round(12_200 / KMH_60), 128]);
    expect(result!.legs[0].durationSeconds).toBe(Math.round(12_200 / KMH_60) + 128);
    expect(result!.durationSeconds).toBe(result!.legs[0].durationSeconds);
  });

  it("bounds a matrix entry's average speed, and keeps unreachable pairs null", async () => {
    respond({
      code: "Ok",
      durations: [[600, null]],
      distances: [[15_000, null]],
    });

    const result = await new OsrmRoutingProvider().matrix(
      [{ latitude: 6.4, longitude: 124.7 }],
      [
        { latitude: 6.69, longitude: 124.67 },
        { latitude: 6.7, longitude: 124.68 },
      ]
    );

    // 15 km in 10 min is 90 km/h; the cap makes it 15 min.
    expect(result!.durationsSeconds[0][0]).toBeCloseTo(900, 5);
    expect(result!.durationsSeconds[0][1]).toBeNull();
  });
});
