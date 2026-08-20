import type { GeoPoint } from "./geo.js";

// Last known server-side position per rider, held in process.
//
// This is NOT the live tracking channel. High-frequency pins for the maps stay
// in Firebase RTDB exactly as before (AGENTS.md section 7) — what lands here is
// the most recent point from the low-rate breadcrumb the rider device flushes
// to POST /errands/:id/track. It exists so dispatch can rank riders by real
// travel time and the ETA engine has an origin, neither of which the backend
// could do before (assignRider previously sorted against a hardcoded table of
// three coordinates keyed by database id).
//
// Deliberately in-process, mirroring riderPresenceStore: it is a cache of
// something already durably stored in errand_track_points, so losing it on
// restart costs nothing but a few minutes of staleness.
export interface RiderPosition {
  point: GeoPoint;
  // Device clock at the moment of the fix — the basis for the freshness check,
  // since a point buffered through a blackout may arrive long after it happened.
  recordedAt: number;
  accuracyMeters: number | null;
  headingDeg: number | null;
}

const positions = new Map<number, RiderPosition>();

// Ignores out-of-order arrivals: a flushed offline backlog can deliver points
// older than one already recorded, and those must not overwrite a fresher fix.
export function record(riderId: number, position: RiderPosition): void {
  const existing = positions.get(riderId);
  if (existing && existing.recordedAt >= position.recordedAt) return;
  positions.set(riderId, position);
}

export function get(riderId: number): RiderPosition | undefined {
  return positions.get(riderId);
}

// A position older than `maxAgeMs` is not evidence of where a rider is now.
// Callers pass the same threshold the UI uses to paint a rider as "signal lost"
// so dispatch eligibility and the map can never disagree.
export function getFresh(riderId: number, maxAgeMs: number): RiderPosition | undefined {
  const position = positions.get(riderId);
  if (!position) return undefined;
  return Date.now() - position.recordedAt <= maxAgeMs ? position : undefined;
}

export function clear(riderId: number): void {
  positions.delete(riderId);
}
