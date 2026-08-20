import * as routingProvider from "../../lib/routing/resilientRoutingService.js";
import type { GeoPoint } from "../../lib/routing/types.js";

// One stop the rider must visit, in the order a dispatcher pinned it.
export interface OptimizableStop {
  id: number;
  point: GeoPoint;
  // When true the optimizer may not move this stop from its current position.
  // Real errands carry ordering constraints the router cannot infer — buy the
  // hot food last, hit the store that closes at 5pm first — so the dispatcher
  // can pin any stop in place.
  sequenceLocked: boolean;
}

export interface OptimizedRoute {
  // Stop ids in the order they should be visited.
  order: number[];
  totalDurationSeconds: number;
  // False when the original dispatcher order was already the best (or the only
  // legal) one, so callers can skip a pointless DB write.
  changed: boolean;
}

// Strategy pattern, as prescribed for route optimization in AGENTS.md 3.3.
export interface RouteOptimizationStrategy {
  readonly name: string;
  optimize(
    origin: GeoPoint,
    stops: OptimizableStop[],
    destination: GeoPoint
  ): Promise<OptimizedRoute | null>;
}

// Enumerates every ordering of the unlocked stops while holding locked stops at
// their original index. Errands are capped at 3 stops (AGENTS.md), so the worst
// case is 3! = 6 candidates — exact optimisation is cheaper here than any
// heuristic, and it needs exactly one distance-matrix call regardless of how
// many orderings it scores.
export class ExhaustiveRouteOptimizationStrategy implements RouteOptimizationStrategy {
  readonly name = "exhaustive";

  async optimize(
    origin: GeoPoint,
    stops: OptimizableStop[],
    destination: GeoPoint
  ): Promise<OptimizedRoute | null> {
    // Nothing to reorder: 0 or 1 stop has only one possible sequence.
    if (stops.length < 2) return null;

    const candidates = buildCandidateOrders(stops);
    if (candidates.length <= 1) return null;

    // One matrix over [origin, ...stops, destination] gives every leg cost any
    // candidate ordering could need.
    const points = [origin, ...stops.map((stop) => stop.point), destination];
    const matrix = await routingProvider.matrix(points, points);
    if (!matrix) return null;

    const ORIGIN = 0;
    const DESTINATION = points.length - 1;
    const indexOfStop = new Map(stops.map((stop, i) => [stop.id, i + 1]));

    let best: { order: number[]; cost: number } | null = null;
    for (const order of candidates) {
      let cost = 0;
      let from = ORIGIN;
      for (const stopId of order) {
        const to = indexOfStop.get(stopId) as number;
        cost += matrix.durationsSeconds[from]?.[to] ?? Infinity;
        from = to;
      }
      cost += matrix.durationsSeconds[from]?.[DESTINATION] ?? Infinity;

      if (!Number.isFinite(cost)) continue;
      if (!best || cost < best.cost) best = { order, cost };
    }

    if (!best) return null;

    const original = stops.map((stop) => stop.id);
    return {
      order: best.order,
      totalDurationSeconds: Math.round(best.cost),
      changed: best.order.some((id, i) => id !== original[i]),
    };
  }
}

// Keeps whatever order the dispatcher pinned. The default: reordering someone's
// errand without being asked is a behaviour change, not an optimisation.
export class SequenceOrderStrategy implements RouteOptimizationStrategy {
  readonly name = "sequence";

  async optimize(): Promise<OptimizedRoute | null> {
    return null;
  }
}

// Every ordering that respects the locked positions.
function buildCandidateOrders(stops: OptimizableStop[]): number[][] {
  const movableIds = stops.filter((stop) => !stop.sequenceLocked).map((stop) => stop.id);
  if (movableIds.length < 2) return [];

  return permutations(movableIds).map((permutation) => {
    const queue = [...permutation];
    // Walk the original slots, refilling only the unlocked ones.
    return stops.map((stop) => (stop.sequenceLocked ? stop.id : (queue.shift() as number)));
  });
}

function permutations(values: number[]): number[][] {
  if (values.length <= 1) return [values];
  const result: number[][] = [];
  for (let i = 0; i < values.length; i++) {
    const rest = [...values.slice(0, i), ...values.slice(i + 1)];
    for (const tail of permutations(rest)) result.push([values[i], ...tail]);
  }
  return result;
}

export const defaultRouteOptimizationStrategy: RouteOptimizationStrategy =
  new ExhaustiveRouteOptimizationStrategy();
