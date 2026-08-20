import * as routingProvider from "../../lib/routing/resilientRoutingService.js";
import type { GeoPoint } from "../../lib/routing/types.js";

// Time allowed for the handover itself once the rider reaches the address:
// finding the right gate in a subdivision, the customer coming down. Small, but
// it is the difference between "arrived" and "handed over" and customers judge
// the promise on the latter.
const HANDOFF_SECONDS = 120;

// Below this many observations a category's dwell percentiles are still mostly
// the seeded guess, so the upper bound is padded rather than presented as if it
// were learned from real data.
const MIN_CONFIDENT_SAMPLES = 10;
const LOW_CONFIDENCE_MULTIPLIER = 1.25;

export interface EtaStopInput {
  pinpointId: number;
  point: GeoPoint;
  arrivedAt: Date | null;
  departedAt: Date | null;
  dwellP50Seconds: number;
  dwellP80Seconds: number;
  dwellSampleCount: number;
}

export interface EtaInput {
  // Rider's last known position. Null before a rider is assigned or before any
  // breadcrumb has arrived, in which case the route is measured from the first
  // outstanding stop instead.
  origin: GeoPoint | null;
  stops: EtaStopInput[];
  destination: GeoPoint | null;
  now: Date;
}

export interface EtaResult {
  etaLowAt: Date;
  etaHighAt: Date;
  travelSeconds: number;
  dwellLowSeconds: number;
  dwellHighSeconds: number;
  remainingStopCount: number;
  degraded: boolean;
  provider: string;
}

export interface EtaStrategy {
  readonly name: string;
  compute(input: EtaInput): Promise<EtaResult | null>;
}

// Remaining service time at a stop.
//
// A stop already departed costs nothing. A stop the rider is currently standing
// in costs whatever is LEFT of its expected dwell — so an ETA recomputed 10
// minutes into a 15-minute supermarket run correctly reports 5 minutes, not 15.
// Floored at zero: a rider who has already overstayed the estimate cannot make
// the remaining time negative and pull the ETA earlier.
function remainingDwellSeconds(stop: EtaStopInput, expected: number, now: Date): number {
  if (stop.departedAt) return 0;
  if (!stop.arrivedAt) return expected;
  const elapsed = (now.getTime() - stop.arrivedAt.getTime()) / 1000;
  return Math.max(0, expected - elapsed);
}

// ETA = road travel time + service time at each remaining stop + handover.
//
// The middle term is the whole point. A food delivery is travel plus a near-
// constant pickup; a pabili is dominated by the rider standing in a store —
// hunting items down an aisle, waiting at a counter, queueing to pay. Modelling
// that per merchant category is what stops every multi-store errand from
// systematically under-promising.
//
// The result is a RANGE, never a single number: P50 dwell for the optimistic
// end, P80 for the realistic one. Queue time has a long right tail, so a single
// point estimate is wrong nearly all the time and a mean is worse than a median.
export class DwellAwareEtaStrategy implements EtaStrategy {
  readonly name = "dwell-aware";

  async compute(input: EtaInput): Promise<EtaResult | null> {
    const { origin, stops, destination, now } = input;
    if (!destination) return null;

    const remainingStops = stops.filter((stop) => !stop.departedAt);
    // Prefer the live rider position; fall back to the next outstanding stop so
    // an ETA still exists before the first breadcrumb arrives.
    const start = origin ?? remainingStops[0]?.point ?? null;
    if (!start) return null;

    // A stop the rider is already inside is not a place still to travel to.
    const waypoints = remainingStops
      .filter((stop) => !stop.arrivedAt)
      .map((stop) => stop.point);

    const route = await routingProvider.route([start, ...waypoints, destination]);
    if (!route) return null;

    let dwellLowSeconds = 0;
    let dwellHighSeconds = 0;
    let lowConfidence = false;

    for (const stop of remainingStops) {
      dwellLowSeconds += remainingDwellSeconds(stop, stop.dwellP50Seconds, now);
      dwellHighSeconds += remainingDwellSeconds(stop, stop.dwellP80Seconds, now);
      if (stop.dwellSampleCount < MIN_CONFIDENT_SAMPLES) lowConfidence = true;
    }

    // Widen the upper bound when the numbers underneath are shaky — either the
    // route is a fallback estimate rather than a measured road distance, or the
    // dwell percentiles are still mostly seeded defaults. Widening the high end
    // only, never the low end: the promise gets more cautious, not vaguer in
    // both directions.
    const degraded = route.degraded || lowConfidence;
    const paddedDwellHigh = degraded ? dwellHighSeconds * LOW_CONFIDENCE_MULTIPLIER : dwellHighSeconds;
    const paddedTravel = route.degraded ? route.durationSeconds * LOW_CONFIDENCE_MULTIPLIER : route.durationSeconds;

    const base = now.getTime();
    const lowSeconds = route.durationSeconds + dwellLowSeconds + HANDOFF_SECONDS;
    const highSeconds = paddedTravel + paddedDwellHigh + HANDOFF_SECONDS;

    return {
      etaLowAt: new Date(base + lowSeconds * 1000),
      // Guard against a degenerate range if padding ever produced a high below
      // the low (it cannot today, but the invariant is worth enforcing here
      // rather than discovering it in the customer's UI).
      etaHighAt: new Date(base + Math.max(lowSeconds, highSeconds) * 1000),
      travelSeconds: Math.round(route.durationSeconds),
      dwellLowSeconds: Math.round(dwellLowSeconds),
      dwellHighSeconds: Math.round(paddedDwellHigh),
      remainingStopCount: remainingStops.length,
      degraded,
      provider: route.provider,
    };
  }
}

export const defaultEtaStrategy: EtaStrategy = new DwellAwareEtaStrategy();
