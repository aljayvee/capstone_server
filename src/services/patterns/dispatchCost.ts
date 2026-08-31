import type { GeoPoint } from "../../lib/geo.js";

/**
 * Where a rider will be when they can actually start, and how long until then.
 *
 * Dispatch used to rank candidates on their CURRENT position alone. That treats
 * a rider standing idle and a rider mid-errand with two more queued in the
 * opposite direction as equals, because both are measured from wherever their
 * last GPS fix happened to land.
 *
 * Note that ranking on total tour cost — the usual suggestion — cannot fix this.
 * Every leg after the first store is identical no matter which rider is chosen,
 * so those terms are a constant added to every candidate and cancel out of the
 * comparison. What actually separates candidates is the work they are already
 * carrying, which is what this computes.
 */

export interface RiderCommitment {
  /** Pessimistic end of the errand's ETA range, or null if not yet computed. */
  etaHighAt: Date | null;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
}

export interface FreePoint {
  /** Where the rider will be free. Null when nothing is known about them. */
  point: GeoPoint | null;
  /** Seconds until they can start new work. Zero for an idle rider. */
  availableInSeconds: number;
  /**
   * True when the rider holds work whose finish is unknown, so this fell back to
   * their current position. Ranking is then no better than it was before — worth
   * surfacing rather than presenting a guess as a measurement.
   */
  degraded: boolean;
}

export function whereRiderBecomesFree(
  currentPosition: GeoPoint | null,
  commitments: RiderCommitment[],
  now: number = Date.now()
): FreePoint {
  if (commitments.length === 0) {
    return { point: currentPosition, availableInSeconds: 0, degraded: false };
  }

  // The errand that finishes LAST is the one that decides when the rider is free
  // and where they end up. Taking the nearest or the first would promise a rider
  // who is still three stops from done.
  let latest: { at: number; point: GeoPoint } | null = null;
  let anyUnknown = false;

  for (const c of commitments) {
    const hasPoint = c.deliveryLatitude != null && c.deliveryLongitude != null;
    if (!c.etaHighAt || !hasPoint) {
      anyUnknown = true;
      continue;
    }
    const at = c.etaHighAt.getTime();
    if (!latest || at > latest.at) {
      latest = {
        at,
        point: { latitude: c.deliveryLatitude as number, longitude: c.deliveryLongitude as number },
      };
    }
  }

  // Held work with no computed finish: fall back to current position and zero
  // delay, which is exactly the old behaviour. Better to rank them as they were
  // ranked yesterday than to invent a completion time for them.
  if (!latest) {
    return { point: currentPosition, availableInSeconds: 0, degraded: true };
  }

  return {
    point: latest.point,
    availableInSeconds: Math.max(0, Math.round((latest.at - now) / 1000)),
    degraded: anyUnknown,
  };
}

/**
 * The comparable cost of giving one errand to one rider.
 *
 * Travel time from where they will be free, plus the wait until they are. Both
 * terms are seconds, so they add directly — a rider 3 minutes away who is free
 * now beats a rider 1 minute away who is 20 minutes from finishing.
 */
export function dispatchCostSeconds(
  travelSeconds: number,
  availableInSeconds: number
): number {
  if (!Number.isFinite(travelSeconds)) return Infinity;
  return travelSeconds + availableInSeconds;
}
