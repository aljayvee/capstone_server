import { beforeEach, describe, expect, it, vi } from "vitest";

// Stand-in providers that record the order they were asked in.
const { calls, osrmRoute, googleRoute, osrmSnap, errandFindUnique } = vi.hoisted(() => ({
  errandFindUnique: vi.fn(),
  calls: [] as string[],
  osrmRoute: vi.fn(),
  googleRoute: vi.fn(),
  osrmSnap: vi.fn(),
}));

const result = (provider: string) => ({
  distanceMeters: 1000,
  durationSeconds: 120,
  coordinates: [
    { latitude: 6.69, longitude: 124.67 },
    { latitude: 6.7, longitude: 124.68 },
  ],
  legs: [],
  steps: [],
  provider,
  degraded: false,
});

vi.mock("../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env.js")>()),
  ROUTING_PROVIDER_ORDER: ["osrm", "google", "haversine"],
}));
vi.mock("../src/lib/routing/osrmProvider.js", () => ({
  OsrmRoutingProvider: class {
    readonly name = "osrm";
    isConfigured = () => true;
    route = (points: unknown) => {
      calls.push("osrm");
      return osrmRoute(points);
    };
    snap = (point: unknown) => osrmSnap(point);
  },
}));
vi.mock("../src/lib/routing/googleProvider.js", () => ({
  GoogleRoutingProvider: class {
    readonly name = "google";
    isConfigured = () => true;
    route = (points: unknown) => {
      calls.push("google");
      return googleRoute(points);
    };
    snap = async () => null;
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { errand: { findUnique: errandFindUnique } } }));

import * as resilient from "../src/lib/routing/resilientRoutingService.js";
import { getDirections } from "../src/services/routingService.js";

let lat = 6.6;
const trip = () => {
  // A fresh pair of points per test, so the route cache never answers.
  lat += 0.001;
  return [
    { latitude: lat, longitude: 124.67 },
    { latitude: lat + 0.01, longitude: 124.68 },
  ];
};

beforeEach(() => {
  calls.length = 0;
  osrmRoute.mockReset().mockResolvedValue(result("osrm"));
  googleRoute.mockReset().mockResolvedValue(result("google"));
  osrmSnap.mockReset().mockResolvedValue({ latitude: 1, longitude: 1 });
});

describe("route() with a preferred provider", () => {
  it("keeps the configured order when nothing is preferred", async () => {
    expect((await resilient.route(trip()))!.provider).toBe("osrm");
    expect(calls).toEqual(["osrm"]);
  });

  it("asks Google first when Google's roads are wanted", async () => {
    expect((await resilient.route(trip(), { prefer: "google" }))!.provider).toBe("google");
    expect(calls).toEqual(["google"]);
  });

  it("still falls back to OSRM when Google has no answer", async () => {
    googleRoute.mockResolvedValue(null);
    expect((await resilient.route(trip(), { prefer: "google" }))!.provider).toBe("osrm");
    expect(calls).toEqual(["google", "osrm"]);
  });

  it("caches each provider's route apart", async () => {
    const points = trip();
    expect((await resilient.route(points, { prefer: "osrm" }))!.provider).toBe("osrm");
    expect((await resilient.route(points, { prefer: "google" }))!.provider).toBe("google");
  });
});

describe("the customer's map follows the rider's", () => {
  it("reuses the rider's verdict for the customer tracking that rider's errand", async () => {
    // Google wins a fresh comparison here (the stand-ins answer the same trip),
    // but the rider was told OSRM, and the customer must see what they see.
    googleRoute.mockResolvedValue({ ...result("google"), durationSeconds: 10 });
    const { rememberRiderChoice } = await import("../src/lib/routing/riderRouteChoice.js");
    rememberRiderChoice(3, { strategy: "fastest", chosen: "osrm", drawnWith: "osrm", candidates: [] });
    errandFindUnique.mockResolvedValue({ riderId: 3, customerId: 9 });

    const [origin, destination] = trip();
    const r = await getDirections(origin, destination, [], {
      choose: "fastest",
      errandId: "e-1",
      caller: { id: 9, role: "CUSTOMER" },
    });
    expect(r.selection).toMatchObject({ chosen: "osrm", drawnWith: "osrm" });
  });

  it("does not hand a customer another customer's rider's verdict", async () => {
    googleRoute.mockResolvedValue({ ...result("google"), durationSeconds: 10 });
    errandFindUnique.mockResolvedValue({ riderId: 3, customerId: 10 });
    const [origin, destination] = trip();
    const r = await getDirections(origin, destination, [], {
      choose: "fastest",
      errandId: "e-1",
      caller: { id: 9, role: "CUSTOMER" },
    });
    // Decided afresh: Google's 10-second route wins (outside the one-minute tie).
    expect(r.selection?.chosen).toBe("google");
  });

  it("remembers the rider's verdict when the rider asks", async () => {
    const { riderChoiceFor } = await import("../src/lib/routing/riderRouteChoice.js");
    const [origin, destination] = trip();
    await getDirections(origin, destination, [], { choose: "fastest", caller: { id: 44, role: "RIDER" } });
    expect(riderChoiceFor(44)?.chosen).toBe("osrm");
  });
});

describe("getDirections", () => {
  it("does not snap the origin onto OSM's road before asking Google", async () => {
    const [origin, destination] = trip();
    const directions = await getDirections(origin, destination, [], { prefer: "google" });
    expect(directions.provider).toBe("google");
    expect(osrmSnap).not.toHaveBeenCalled();
    expect(googleRoute.mock.calls[0][0][0]).toEqual(origin);
  });

  it("snaps for OSRM as before", async () => {
    const [origin, destination] = trip();
    await getDirections(origin, destination, [], { prefer: "osrm" });
    expect(osrmSnap).toHaveBeenCalledTimes(1);
    expect(osrmRoute.mock.calls[0][0][0]).toEqual({ latitude: 1, longitude: 1 });
  });
});
