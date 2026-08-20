import { beforeEach, describe, expect, it, vi } from "vitest";

// The strategy's only external dependency is the routing chain; stubbing it
// keeps these tests about the dwell/range arithmetic, which is the part that
// makes an errand ETA different from a delivery ETA.
vi.mock("../src/lib/routing/resilientRoutingService.js", () => ({
  route: vi.fn(),
}));

import * as routingProvider from "../src/lib/routing/resilientRoutingService.js";
import { DwellAwareEtaStrategy, type EtaStopInput } from "../src/services/patterns/etaStrategy.js";

const routeMock = vi.mocked(routingProvider.route);
const NOW = new Date("2026-08-20T08:00:00.000Z");
const HANDOFF = 120;

function stubRoute(durationSeconds: number, degraded = false) {
  routeMock.mockResolvedValue({
    distanceMeters: 3000,
    durationSeconds,
    coordinates: [],
    encodedGeometry: null,
    legs: [],
    provider: degraded ? "haversine" : "osrm",
    degraded,
  } as any);
}

function stop(overrides: Partial<EtaStopInput> = {}): EtaStopInput {
  return {
    pinpointId: 1,
    point: { latitude: 6.6873, longitude: 124.6752 },
    arrivedAt: null,
    departedAt: null,
    dwellP50Seconds: 900,
    dwellP80Seconds: 1800,
    dwellSampleCount: 50,
    ...overrides,
  };
}

const DESTINATION = { latitude: 6.6702, longitude: 124.6635 };
const ORIGIN = { latitude: 6.6912, longitude: 124.6765 };
const strategy = new DwellAwareEtaStrategy();

const secondsFromNow = (date: Date) => Math.round((date.getTime() - NOW.getTime()) / 1000);

describe("dwell-aware ETA", () => {
  beforeEach(() => vi.resetAllMocks());

  it("adds store service time on top of travel time", async () => {
    stubRoute(600);
    const result = await strategy.compute({
      origin: ORIGIN, stops: [stop()], destination: DESTINATION, now: NOW,
    });

    // This is the whole point of the model: a pure travel ETA would promise
    // 10 minutes for an errand that realistically takes 27-42.
    expect(result!.travelSeconds).toBe(600);
    expect(secondsFromNow(result!.etaLowAt)).toBe(600 + 900 + HANDOFF);
    expect(secondsFromNow(result!.etaHighAt)).toBe(600 + 1800 + HANDOFF);
  });

  it("always returns a range, never a single point estimate", async () => {
    stubRoute(600);
    const result = await strategy.compute({
      origin: ORIGIN, stops: [stop()], destination: DESTINATION, now: NOW,
    });
    expect(result!.etaHighAt.getTime()).toBeGreaterThan(result!.etaLowAt.getTime());
  });

  it("sums dwell across a multi-stop errand", async () => {
    stubRoute(600);
    const result = await strategy.compute({
      origin: ORIGIN,
      stops: [
        stop({ pinpointId: 1, dwellP50Seconds: 900, dwellP80Seconds: 1800 }),
        stop({ pinpointId: 2, dwellP50Seconds: 480, dwellP80Seconds: 900 }),
      ],
      destination: DESTINATION,
      now: NOW,
    });
    expect(result!.dwellLowSeconds).toBe(900 + 480);
    expect(result!.remainingStopCount).toBe(2);
  });

  it("charges nothing for a stop the rider has already left", async () => {
    stubRoute(600);
    const result = await strategy.compute({
      origin: ORIGIN,
      stops: [
        stop({ pinpointId: 1, arrivedAt: new Date(NOW.getTime() - 900_000), departedAt: new Date(NOW.getTime() - 60_000) }),
        stop({ pinpointId: 2, dwellP50Seconds: 480, dwellP80Seconds: 900 }),
      ],
      destination: DESTINATION,
      now: NOW,
    });
    expect(result!.dwellLowSeconds).toBe(480);
    expect(result!.remainingStopCount).toBe(1);
  });

  it("counts only the remaining dwell for a stop the rider is standing in", async () => {
    stubRoute(600);
    // 10 minutes into a 15-minute expected supermarket run.
    const result = await strategy.compute({
      origin: ORIGIN,
      stops: [stop({ arrivedAt: new Date(NOW.getTime() - 600_000) })],
      destination: DESTINATION,
      now: NOW,
    });
    expect(result!.dwellLowSeconds).toBe(300);
  });

  it("never lets an overstayed stop pull the ETA earlier", async () => {
    stubRoute(600);
    // 40 minutes into a 15-minute expectation — remaining dwell floors at 0
    // rather than going negative.
    const result = await strategy.compute({
      origin: ORIGIN,
      stops: [stop({ arrivedAt: new Date(NOW.getTime() - 2_400_000) })],
      destination: DESTINATION,
      now: NOW,
    });
    expect(result!.dwellLowSeconds).toBe(0);
    expect(secondsFromNow(result!.etaLowAt)).toBe(600 + HANDOFF);
  });

  it("widens only the upper bound when the route is a fallback estimate", async () => {
    stubRoute(600, true);
    const result = await strategy.compute({
      origin: ORIGIN, stops: [stop()], destination: DESTINATION, now: NOW,
    });
    expect(result!.degraded).toBe(true);
    // Low end stays honest at the measured numbers...
    expect(secondsFromNow(result!.etaLowAt)).toBe(600 + 900 + HANDOFF);
    // ...while the high end pads travel and dwell by 25%.
    expect(secondsFromNow(result!.etaHighAt)).toBe(Math.round(600 * 1.25 + 1800 * 1.25) + HANDOFF);
  });

  it("flags low confidence while a category is still on seeded defaults", async () => {
    stubRoute(600);
    const result = await strategy.compute({
      origin: ORIGIN, stops: [stop({ dwellSampleCount: 3 })], destination: DESTINATION, now: NOW,
    });
    expect(result!.degraded).toBe(true);
  });

  it("routes from the next outstanding stop when no rider position exists yet", async () => {
    stubRoute(600);
    await strategy.compute({
      origin: null, stops: [stop()], destination: DESTINATION, now: NOW,
    });
    expect(routeMock.mock.calls[0][0][0]).toEqual(stop().point);
  });

  it("does not route to a stop the rider is already inside", async () => {
    stubRoute(600);
    await strategy.compute({
      origin: ORIGIN,
      stops: [stop({ arrivedAt: new Date(NOW.getTime() - 60_000) })],
      destination: DESTINATION,
      now: NOW,
    });
    // Only origin + destination — the current stop is not a waypoint to travel to.
    expect(routeMock.mock.calls[0][0]).toEqual([ORIGIN, DESTINATION]);
  });

  it("returns null without a destination to aim at", async () => {
    stubRoute(600);
    expect(await strategy.compute({
      origin: ORIGIN, stops: [stop()], destination: null, now: NOW,
    })).toBeNull();
  });

  it("returns null when no provider can route at all", async () => {
    routeMock.mockResolvedValue(null);
    expect(await strategy.compute({
      origin: ORIGIN, stops: [stop()], destination: DESTINATION, now: NOW,
    })).toBeNull();
  });
});
