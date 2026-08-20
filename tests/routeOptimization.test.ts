import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/routing/resilientRoutingService.js", () => ({ matrix: vi.fn() }));

import * as routingProvider from "../src/lib/routing/resilientRoutingService.js";
import {
  ExhaustiveRouteOptimizationStrategy,
  SequenceOrderStrategy,
  type OptimizableStop,
} from "../src/services/patterns/routeOptimizationStrategy.js";

const matrixMock = vi.mocked(routingProvider.matrix);
const P = (n: number) => ({ latitude: 6.67 + n / 1000, longitude: 124.66 + n / 1000 });
const ORIGIN = P(0);
const DESTINATION = P(9);
const strategy = new ExhaustiveRouteOptimizationStrategy();

// points are [origin, stopA, stopB, destination]; durations[from][to].
function stubMatrix(durations: number[][]) {
  matrixMock.mockResolvedValue({
    durationsSeconds: durations,
    distancesMeters: durations,
    provider: "osrm",
    degraded: false,
  } as any);
}

const stop = (id: number, sequenceLocked = false): OptimizableStop => ({
  id, point: P(id), sequenceLocked,
});

describe("exhaustive route optimization", () => {
  beforeEach(() => vi.resetAllMocks());

  it("finds the cheaper ordering when the pinned one is worse", () => {
    // Visiting B then A costs 100+100+100 = 300; A then B costs 600+100+600.
    stubMatrix([
      /* from origin */ [0, 600, 100, 999],
      /* from A      */ [600, 0, 100, 100],
      /* from B      */ [100, 100, 0, 600],
      /* from dest   */ [999, 100, 600, 0],
    ]);
    return strategy.optimize(ORIGIN, [stop(1), stop(2)], DESTINATION).then((result) => {
      expect(result!.order).toEqual([2, 1]);
      expect(result!.changed).toBe(true);
      expect(result!.totalDurationSeconds).toBe(300);
    });
  });

  it("keeps the dispatcher order when it is already optimal", async () => {
    stubMatrix([
      [0, 100, 600, 999],
      [100, 0, 100, 600],
      [600, 100, 0, 100],
      [999, 600, 100, 0],
    ]);
    const result = await strategy.optimize(ORIGIN, [stop(1), stop(2)], DESTINATION);
    expect(result!.order).toEqual([1, 2]);
    expect(result!.changed).toBe(false);
  });

  it("uses exactly one matrix call regardless of how many orderings it scores", async () => {
    stubMatrix([
      [0, 100, 200, 300, 400],
      [100, 0, 100, 200, 300],
      [200, 100, 0, 100, 200],
      [300, 200, 100, 0, 100],
      [400, 300, 200, 100, 0],
    ]);
    await strategy.optimize(ORIGIN, [stop(1), stop(2), stop(3)], DESTINATION);
    expect(matrixMock).toHaveBeenCalledTimes(1);
  });

  it("never moves a stop the dispatcher pinned in place", async () => {
    // Same costs as the reordering case, but stop 1 is locked to slot 0.
    stubMatrix([
      [0, 600, 100, 999],
      [600, 0, 100, 100],
      [100, 100, 0, 600],
      [999, 100, 600, 0],
    ]);
    const result = await strategy.optimize(
      ORIGIN, [stop(1, true), stop(2)], DESTINATION
    );
    // Only one movable stop left, so there is nothing legal to permute.
    expect(result).toBeNull();
  });

  it("holds a locked stop's slot while reordering the rest", async () => {
    stubMatrix([
      [0, 100, 100, 100, 100],
      [100, 0, 100, 100, 100],
      [100, 100, 0, 100, 100],
      [100, 100, 100, 0, 100],
      [100, 100, 100, 100, 0],
    ]);
    const result = await strategy.optimize(
      ORIGIN, [stop(1), stop(2, true), stop(3)], DESTINATION
    );
    // Whatever ordering wins, the locked stop stays at index 1.
    expect(result!.order[1]).toBe(2);
  });

  it("does nothing with fewer than two stops", async () => {
    expect(await strategy.optimize(ORIGIN, [stop(1)], DESTINATION)).toBeNull();
    expect(matrixMock).not.toHaveBeenCalled();
  });

  it("gives up rather than guessing when the matrix is unavailable", async () => {
    matrixMock.mockResolvedValue(null);
    expect(await strategy.optimize(ORIGIN, [stop(1), stop(2)], DESTINATION)).toBeNull();
  });

  it("skips orderings containing an unreachable leg", async () => {
    // B is unreachable from the origin, so the only viable order is A then B.
    stubMatrix([
      [0, 100, Infinity, 999],
      [100, 0, 100, 600],
      [Infinity, 100, 0, 100],
      [999, 600, 100, 0],
    ]);
    const result = await strategy.optimize(ORIGIN, [stop(1), stop(2)], DESTINATION);
    expect(result!.order).toEqual([1, 2]);
    expect(Number.isFinite(result!.totalDurationSeconds)).toBe(true);
  });
});

describe("sequence order strategy", () => {
  it("is a no-op so an errand is never silently reordered by default", async () => {
    expect(await new SequenceOrderStrategy().optimize()).toBeNull();
  });
});
