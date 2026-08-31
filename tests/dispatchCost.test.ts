import { describe, expect, it } from "vitest";
import {
  whereRiderBecomesFree,
  dispatchCostSeconds,
  type RiderCommitment,
} from "../src/services/patterns/dispatchCost.js";

/**
 * Ranking riders by what they are already carrying, not by where they happen to be.
 *
 * The audit that prompted this argued the ranking should optimise total tour
 * cost. It should not — and cannot: every leg after the first store is identical
 * whichever rider is chosen, so those terms are a constant added to each
 * candidate and cancel out of the comparison. What actually separates two
 * candidates is the work already on them, which is what these cover.
 */

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const minutes = (n: number) => new Date(NOW + n * 60_000);

const HERE = { latitude: 6.6873, longitude: 124.6752 };
const ACROSS_TOWN = { latitude: 6.7150, longitude: 124.7050 };

const commitment = (over: Partial<RiderCommitment> = {}): RiderCommitment => ({
  etaHighAt: minutes(20),
  deliveryLatitude: ACROSS_TOWN.latitude,
  deliveryLongitude: ACROSS_TOWN.longitude,
  ...over,
});

describe("where a rider becomes free", () => {
  it("is here and now for an idle rider", () => {
    const free = whereRiderBecomesFree(HERE, [], NOW);
    expect(free.point).toEqual(HERE);
    expect(free.availableInSeconds).toBe(0);
    expect(free.degraded).toBe(false);
  });

  it("is the end of their work, not their current fix", () => {
    const free = whereRiderBecomesFree(HERE, [commitment()], NOW);
    expect(free.point).toEqual(ACROSS_TOWN);
    expect(free.availableInSeconds).toBe(20 * 60);
  });

  it("follows the errand that finishes LAST, not the nearest one", () => {
    // Taking the first or the closest would promise a rider who is still two
    // deliveries from done.
    const free = whereRiderBecomesFree(
      HERE,
      [
        commitment({ etaHighAt: minutes(5), deliveryLatitude: 6.69, deliveryLongitude: 124.68 }),
        commitment({ etaHighAt: minutes(35) }),
      ],
      NOW
    );
    expect(free.point).toEqual(ACROSS_TOWN);
    expect(free.availableInSeconds).toBe(35 * 60);
  });

  it("never reports a negative wait for an overdue errand", () => {
    const free = whereRiderBecomesFree(HERE, [commitment({ etaHighAt: minutes(-15) })], NOW);
    expect(free.availableInSeconds).toBe(0);
  });

  it("falls back to today's behaviour when a held errand has no computed finish", () => {
    // Better to rank them as they were ranked yesterday than to invent a
    // completion time — and say so, rather than presenting a guess as a measurement.
    const free = whereRiderBecomesFree(HERE, [commitment({ etaHighAt: null })], NOW);
    expect(free.point).toEqual(HERE);
    expect(free.availableInSeconds).toBe(0);
    expect(free.degraded).toBe(true);
  });

  it("flags degradation when only SOME of the held work is unknown", () => {
    const free = whereRiderBecomesFree(
      HERE,
      [commitment({ etaHighAt: minutes(30) }), commitment({ etaHighAt: null })],
      NOW
    );
    expect(free.availableInSeconds).toBe(30 * 60);
    expect(free.degraded).toBe(true);
  });

  it("returns no point for a rider with no known position and no priced work", () => {
    const free = whereRiderBecomesFree(null, [], NOW);
    expect(free.point).toBeNull();
  });
});

describe("comparing two candidates", () => {
  it("prefers the further rider who is free now over the nearer one still working", () => {
    // The whole point. Three minutes away and idle beats one minute away and
    // twenty minutes from finishing.
    const idleNearby = dispatchCostSeconds(180, 0);
    const busyCloser = dispatchCostSeconds(60, 20 * 60);
    expect(idleNearby).toBeLessThan(busyCloser);
  });

  it("still prefers the nearer rider when both are free", () => {
    expect(dispatchCostSeconds(60, 0)).toBeLessThan(dispatchCostSeconds(180, 0));
  });

  it("keeps an unroutable rider last rather than ranking them first", () => {
    expect(dispatchCostSeconds(Infinity, 0)).toBe(Infinity);
  });
});
