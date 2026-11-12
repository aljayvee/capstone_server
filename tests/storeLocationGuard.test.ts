import { beforeEach, describe, expect, it, vi } from "vitest";

const { nearestRoadMeters } = vi.hoisted(() => ({ nearestRoadMeters: vi.fn() }));

vi.mock("../src/lib/routing/osrmProvider.js", () => ({
  OsrmRoutingProvider: class {
    nearestRoadMeters = nearestRoadMeters;
  },
}));

import { checkStoreLocation, clearStoreLocationCache, OFF_GRAPH_METERS } from "../src/services/storeLocationGuard.js";

// The committed service area is the Tacurong envelope, SW 6.62,124.60 - NE 6.74,124.73.
const TACURONG_PLAZA = { latitude: 6.6873, longitude: 124.6752 };
// ~10 km south of the envelope, on the Koronadal road: in the region graph.
const TANTANGAN_ROAD = { latitude: 6.53, longitude: 124.72 };
// Well north of the graph's 6.78 edge.
const OFF_MAP = { latitude: 7.1, longitude: 124.66 };

beforeEach(() => {
  clearStoreLocationCache();
  nearestRoadMeters.mockReset();
});

describe("checkStoreLocation", () => {
  it("passes a store inside Tacurong without comment", async () => {
    nearestRoadMeters.mockResolvedValue(12);
    const verdict = await checkStoreLocation(TACURONG_PLAZA);
    expect(verdict.status).toBe("inside");
    expect(verdict.kmBeyondBorder).toBe(0);
  });

  it("strictly blocks a store > 100m past the Tacurong border even if on the road graph", async () => {
    nearestRoadMeters.mockResolvedValue(20);
    const verdict = await checkStoreLocation(TANTANGAN_ROAD);
    expect(verdict.status).toBe("blocked");
    expect(verdict.reason).toBe("outside_border");
    // Measured to the NEAREST zone: since Banga became a zone (2026-11-09) that
    // is Banga's northern tip, about 3.8 km away, not Tacurong's edge.
    expect(verdict.kmBeyondBorder).toBeGreaterThan(3);
    expect(verdict.message).toMatch(/outside all supported service areas/);
  });

  it("passes a store inside Banga, the second service zone, and names it", async () => {
    nearestRoadMeters.mockResolvedValue(15);
    const verdict = await checkStoreLocation({ latitude: 6.4232, longitude: 124.7762 });
    expect(verdict.status).toBe("inside");
    expect(verdict.message).toBe("Inside Banga.");
  });

  it("blocks a spot off the loaded road graph, however it got there", async () => {
    nearestRoadMeters.mockResolvedValue(38_000);
    const verdict = await checkStoreLocation(OFF_MAP);
    expect(verdict.status).toBe("blocked");
    expect(verdict.message).toMatch(/outside all supported service areas|outside the road map/);
  });

  it("strictly rejects spots outside border regardless of graph road distance", async () => {
    nearestRoadMeters.mockResolvedValue(OFF_GRAPH_METERS + 1);
    expect((await checkStoreLocation(TANTANGAN_ROAD)).status).toBe("blocked");

    clearStoreLocationCache();
    nearestRoadMeters.mockResolvedValue(30);
    expect((await checkStoreLocation(TANTANGAN_ROAD)).status).toBe("blocked");
    expect((await checkStoreLocation(TANTANGAN_ROAD)).reason).toBe("outside_border");
  });

  it("strictly flags and blocks outside stores even when OSRM is down", async () => {
    nearestRoadMeters.mockRejectedValue(new Error("ECONNREFUSED"));
    const verdict = await checkStoreLocation(OFF_MAP);
    expect(verdict.status).toBe("blocked");
    expect(verdict.reason).toBe("outside_border");
    expect(verdict.graphChecked).toBe(false);
  });

  it("does not cache a fail-open answer past an outage", async () => {
    nearestRoadMeters.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(12);
    expect((await checkStoreLocation(TACURONG_PLAZA)).status).toBe("inside");
    expect((await checkStoreLocation(TACURONG_PLAZA)).status).toBe("inside");
  });

  it("permits a roadside store within the 100m edge buffer but blocks beyond it", async () => {
    nearestRoadMeters.mockResolvedValue(10);
    // ~50m outside border
    const verdict50m = await checkStoreLocation({ latitude: 6.68388, longitude: 124.61901 });
    expect(verdict50m.status).toBe("inside");

    // ~200m outside border
    const verdict200m = await checkStoreLocation({ latitude: 6.68388, longitude: 124.61765 });
    expect(verdict200m.status).toBe("blocked");
    expect(verdict200m.reason).toBe("outside_border");
  });

  it("handles string coordinates and invalid non-finite coordinates without throwing", async () => {
    nearestRoadMeters.mockResolvedValue(15);
    const stringVerdict = await checkStoreLocation({ latitude: "6.6873" as any, longitude: "124.6752" as any });
    expect(stringVerdict.status).toBe("inside");

    const nanVerdict = await checkStoreLocation({ latitude: NaN, longitude: NaN });
    expect(nanVerdict.status).toBe("blocked");
    expect(nanVerdict.reason).toBe("outside_border");
  });
});
