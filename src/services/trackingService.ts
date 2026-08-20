import { randomUUID } from "node:crypto";
import * as riderPositionStore from "../lib/riderPositionStore.js";
import * as routingProvider from "../lib/routing/resilientRoutingService.js";
import type { TracePoint } from "../lib/routing/types.js";
import { evaluateFix, type QualityCandidate, type RejectionReason } from "../lib/trackQuality.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { pinpointRepository } from "../repositories/pinpointRepository.js";
import { trackPointRepository, type TrackPointCreateData } from "../repositories/trackPointRepository.js";
import * as etaService from "./etaService.js";
import { applyGeofenceTransitions, type GeofenceTransition } from "./geofenceService.js";
import { ServiceError } from "./ServiceError.js";
import type { TrackPointInput } from "../validators/trackingValidators.js";

// Below this many points, map matching costs a round trip and buys little — a
// couple of fixes carry too little shape for the engine to choose a road from.
const MIN_POINTS_TO_MAP_MATCH = 5;

// A breadcrumb only makes sense while the rider is actually working the errand.
const TRACKABLE_STATUSES = new Set(["ASSIGNED", "IN_TRANSIT"]);

export interface IngestResult {
  accepted: number;
  stored: number;
  rejected: Record<RejectionReason, number>;
  mapMatched: boolean;
  transitions: GeofenceTransition[];
}

export async function ingestBatch(
  errandId: string,
  riderId: number,
  points: TrackPointInput[]
): Promise<IngestResult> {
  const errand = await errandRepository.findById(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");

  // Object-level authorization: a rider may only contribute to the trail of an
  // errand actually assigned to them.
  if (errand.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: this errand is not assigned to you.");
  }
  if (!TRACKABLE_STATUSES.has(errand.status)) {
    throw new ServiceError(409, `Cannot record location for an errand that is ${errand.status}.`);
  }

  // A flushed offline backlog arrives in whatever order the queue held it.
  // Everything downstream — the quality gate, geofencing, dwell — assumes
  // chronological order by device clock.
  const ordered = [...points].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

  const latest = await trackPointRepository.findLatestForRider(riderId);
  let previous: QualityCandidate | null = latest
    ? {
        latitude: latest.latitude,
        longitude: latest.longitude,
        accuracyMeters: latest.accuracyMeters,
        recordedAt: latest.recordedAt,
      }
    : null;

  const rejected: Record<RejectionReason, number> = {
    inaccurate: 0,
    out_of_order: 0,
    implausible_speed: 0,
  };
  const accepted: TrackPointInput[] = [];

  for (const point of ordered) {
    const decision = evaluateFix(point, previous);
    if (!decision.accepted) {
      rejected[decision.reason as RejectionReason] += 1;
      continue;
    }
    accepted.push(point);
    previous = point;
  }

  if (accepted.length === 0) {
    return { accepted: 0, stored: 0, rejected, mapMatched: false, transitions: [] };
  }

  const matchedByIndex = await mapMatch(accepted);

  const rows: TrackPointCreateData[] = accepted.map((point, index) => {
    const matched = matchedByIndex.get(index);
    return {
      errandId,
      riderId,
      latitude: matched?.latitude ?? point.latitude,
      longitude: matched?.longitude ?? point.longitude,
      accuracyMeters: point.accuracyMeters ?? null,
      speedMps: point.speedMps ?? null,
      headingDeg: point.headingDeg ?? null,
      recordedAt: point.recordedAt,
      isMapMatched: Boolean(matched),
      wasOffline: point.wasOffline,
      // Defensive: the validator requires a client id, but never let a missing
      // one collapse a whole batch onto one unique-index slot.
      clientPointId: point.clientPointId || randomUUID(),
    };
  });

  const { count } = await trackPointRepository.createMany(rows);

  const newest = rows[rows.length - 1];
  riderPositionStore.record(riderId, {
    point: { latitude: newest.latitude, longitude: newest.longitude },
    recordedAt: newest.recordedAt.getTime(),
    accuracyMeters: newest.accuracyMeters ?? null,
    headingDeg: newest.headingDeg ?? null,
  });

  const stops = await pinpointRepository.findByErrandId(errandId);
  const transitions = await applyGeofenceTransitions(
    errandId,
    stops.map((stop) => ({
      id: stop.id,
      latitude: stop.latitude,
      longitude: stop.longitude,
      categoryId: stop.categoryId,
      placeId: stop.placeId,
      arrivedAt: stop.arrivedAt,
      departedAt: stop.departedAt,
    })),
    rows.map((row) => ({
      latitude: row.latitude,
      longitude: row.longitude,
      recordedAt: row.recordedAt,
    }))
  );

  // Recompute off the request path — a slow routing call must never delay the
  // rider's upload. Forced when a stop was reached or left, since those change
  // the remaining work materially; otherwise throttled inside the ETA service.
  etaService.recomputeInBackground(errandId, { force: transitions.length > 0 });

  // A rider who has been inside a store far longer than that store type usually
  // takes is the defining case of an errand: they are queueing, not stuck. Tell
  // the customer why rather than letting the ETA quietly slide.
  void etaService.detectStalledStop(errandId).catch(() => {});

  return {
    accepted: accepted.length,
    stored: count,
    rejected,
    mapMatched: matchedByIndex.size > 0,
    transitions,
  };
}

// Snaps the batch onto the road network, returning corrected coordinates keyed
// by their index in the accepted list. Falls back to an empty map — and so to
// the raw GPS — whenever matching is unavailable or the engine is not confident,
// because an honest raw fix beats a confident wrong one in a dispute.
async function mapMatch(
  accepted: TrackPointInput[]
): Promise<Map<number, { latitude: number; longitude: number }>> {
  const result = new Map<number, { latitude: number; longitude: number }>();
  if (accepted.length < MIN_POINTS_TO_MAP_MATCH) return result;

  const trace: TracePoint[] = accepted.map((point) => ({
    point: { latitude: point.latitude, longitude: point.longitude },
    timestampSec: Math.floor(point.recordedAt.getTime() / 1000),
  }));

  const matched = await routingProvider.match(trace);
  if (!matched) return result;

  for (const entry of matched.points) {
    result.set(entry.sourceIndex, entry.point);
  }
  return result;
}

export async function listTrack(errandId: string) {
  return trackPointRepository.listForErrand(errandId);
}
