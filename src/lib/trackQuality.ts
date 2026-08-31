import { haversineDistanceKm } from "./geo.js";

// A fix this imprecise tells us the rider is "somewhere in this block" — useless
// for deciding which store they are standing in, and actively harmful if it
// drags a geofence or an ETA around.
export const MAX_ACCURACY_METERS = 50;

// No vehicle on Tacurong city streets sustains this. A fix implying it is a GPS
// glitch (a cold-start fix, a cell-tower estimate) rather than real movement,
// and accepting one puts a spike in the trail that map matching then tries to
// honour.
export const MAX_PLAUSIBLE_SPEED_MPS = 30;

// Below this, apparent movement is jitter rather than travel. Used to avoid
// treating a parked rider's noise as a departure from a geofence.
export const STATIONARY_SPEED_MPS = 0.5;

/**
 * Past this gap, the previous fix says nothing about where the rider should be
 * now, so the speed check is skipped rather than applied to a stale anchor.
 *
 * A rider who was last seen an hour ago has legitimately been anywhere in the
 * city since. Measuring "speed" across that gap does not test plausibility, it
 * tests how long the app was closed — and because ingestBatch only advances its
 * anchor on an ACCEPTED fix, one such rejection rejects the entire batch behind
 * it, then the next batch, indefinitely: nothing is stored, so the stale anchor
 * is still the latest point next time. That is a trail that dies silently and
 * never recovers, which is the opposite of what a quality gate is for.
 */
export const MAX_ANCHOR_AGE_SECONDS = 5 * 60;

export interface QualityCandidate {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  recordedAt: Date;
}

export type RejectionReason = "inaccurate" | "out_of_order" | "implausible_speed";

export interface QualityDecision {
  accepted: boolean;
  reason?: RejectionReason;
}

// Decides whether one fix is worth keeping, given the last fix already accepted
// for that rider.
//
// Runs on the server as well as the device on purpose: the client gate saves
// bandwidth and battery, but the server cannot assume a well-behaved client —
// a stale build, a bug, or a crafted request would otherwise write nonsense
// into the trail that dispute replay and dwell learning both depend on.
export function evaluateFix(
  candidate: QualityCandidate,
  previous: QualityCandidate | null
): QualityDecision {
  if (
    candidate.accuracyMeters !== null &&
    candidate.accuracyMeters !== undefined &&
    candidate.accuracyMeters > MAX_ACCURACY_METERS
  ) {
    return { accepted: false, reason: "inaccurate" };
  }

  if (!previous) return { accepted: true };

  const elapsedSeconds = (candidate.recordedAt.getTime() - previous.recordedAt.getTime()) / 1000;

  // Equal timestamps are a duplicate, not a step backwards in time; either way
  // there is no new information in it.
  if (elapsedSeconds <= 0) {
    return { accepted: false, reason: "out_of_order" };
  }

  // Stale anchor: nothing to compare against that means anything. Accuracy has
  // already been checked, and that is the whole of what can honestly be said
  // about a fix arriving after a long silence.
  if (elapsedSeconds > MAX_ANCHOR_AGE_SECONDS) {
    return { accepted: true };
  }

  const metres = haversineDistanceKm(candidate, previous) * 1000;
  if (metres / elapsedSeconds > MAX_PLAUSIBLE_SPEED_MPS) {
    return { accepted: false, reason: "implausible_speed" };
  }

  return { accepted: true };
}
