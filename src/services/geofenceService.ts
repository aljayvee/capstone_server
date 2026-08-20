import { haversineDistanceKm } from "../lib/geo.js";
import { dwellObservationRepository } from "../repositories/dwellObservationRepository.js";
import { pinpointRepository } from "../repositories/pinpointRepository.js";

// How close counts as "at the store". Wide enough to survive ordinary urban GPS
// error and a rider parking round the back; tight enough that two stores on the
// same block don't both trigger.
export const GEOFENCE_RADIUS_METERS = 75;

// A rider who briefly clips the radius while riding past has not arrived. They
// must be inside for at least this long before it counts.
const MIN_PRESENCE_SECONDS = 60;

export interface GeofencePoint {
  latitude: number;
  longitude: number;
  recordedAt: Date;
}

export interface GeofenceStop {
  id: number;
  latitude: number;
  longitude: number;
  categoryId: number | null;
  placeId: string | null;
  arrivedAt: Date | null;
  departedAt: Date | null;
}

export interface GeofenceTransition {
  pinpointId: number;
  kind: "arrived" | "departed";
  at: Date;
  dwellSeconds?: number;
}

function isInside(point: GeofencePoint, stop: GeofenceStop): boolean {
  return haversineDistanceKm(point, stop) * 1000 <= GEOFENCE_RADIUS_METERS;
}

// Derives arrival and departure at each stop from a chronologically ordered
// breadcrumb, and records a dwell observation when a stop completes.
//
// This is the measurement half of the ETA model: every completed stop becomes a
// data point that jobs/dwellLearning.ts turns into the per-category percentiles
// the next customer's ETA is built from.
export async function applyGeofenceTransitions(
  errandId: string,
  stops: GeofenceStop[],
  points: GeofencePoint[]
): Promise<GeofenceTransition[]> {
  const transitions: GeofenceTransition[] = [];
  if (points.length === 0) return transitions;

  for (const stop of stops) {
    if (stop.departedAt) continue;

    let arrivedAt = stop.arrivedAt;

    if (!arrivedAt) {
      const firstInside = points.find((point) => isInside(point, stop));
      if (!firstInside) continue;

      // Require sustained presence so a drive-past doesn't register as a visit.
      const lastInsideRun = points
        .filter((point) => point.recordedAt >= firstInside.recordedAt && isInside(point, stop))
        .pop();
      const presenceSeconds = lastInsideRun
        ? (lastInsideRun.recordedAt.getTime() - firstInside.recordedAt.getTime()) / 1000
        : 0;

      // The only fix inside so far may simply be the newest one — the rider has
      // just pulled up. Accept it and let a later batch confirm; a false arrival
      // self-corrects, whereas a missed one loses the dwell observation entirely.
      const stillInsideAtEnd = isInside(points[points.length - 1], stop);
      if (presenceSeconds < MIN_PRESENCE_SECONDS && !stillInsideAtEnd) continue;

      arrivedAt = firstInside.recordedAt;
      await pinpointRepository.markArrived(stop.id, arrivedAt);
      transitions.push({ pinpointId: stop.id, kind: "arrived", at: arrivedAt });
    }

    // Departure: the first fix after arrival that is outside the radius.
    const departure = points.find(
      (point) => point.recordedAt > (arrivedAt as Date) && !isInside(point, stop)
    );
    if (!departure) continue;

    const dwellSeconds = Math.round(
      (departure.recordedAt.getTime() - (arrivedAt as Date).getTime()) / 1000
    );

    await pinpointRepository.markDeparted(stop.id, departure.recordedAt);
    transitions.push({
      pinpointId: stop.id,
      kind: "departed",
      at: departure.recordedAt,
      dwellSeconds,
    });

    // Guard against a duplicate observation if a retried batch re-derives the
    // same departure.
    const already = await dwellObservationRepository.existsForPinpoint(stop.id);
    if (!already && dwellSeconds > 0) {
      await dwellObservationRepository.create({
        errandId,
        pinpointId: stop.id,
        categoryId: stop.categoryId,
        placeId: stop.placeId,
        dwellSeconds,
        arrivedAt: arrivedAt as Date,
        departedAt: departure.recordedAt,
      });
    }
  }

  return transitions;
}
