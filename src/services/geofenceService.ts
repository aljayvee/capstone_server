import { haversineDistanceKm } from "../lib/geo.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { logger } from "../lib/logger.js";
import { dwellObservationRepository } from "../repositories/dwellObservationRepository.js";
import { pinpointRepository } from "../repositories/pinpointRepository.js";
import { placeRepository } from "../repositories/placeRepository.js";
import { trackPointRepository } from "../repositories/trackPointRepository.js";
import { storeAutoCorrectionService } from "./storeAutoCorrectionService.js";
import { notifyStaffAboutErrand } from "./notificationService.js";

// How close counts as "at the store". Wide enough to survive ordinary urban GPS
// error and a rider parking round the back.
//
// It is NOT tight enough to separate neighbouring stores, and it cannot be: the
// downtown catalogue sits 25-110 m apart (Jollibee Main to Greenwich is ~89 m,
// to Chowking ~95 m), so two 75 m circles genuinely overlap and one fix can fall
// inside both. Shrinking the radius to fix that would lose real arrivals, so the
// ambiguity is resolved by attribution instead — see ownerOf() below.
// The fallback, used for a stop whose category carries no radius of its own —
// a pin dropped outside the catalogue, or a category from before the column
// existed. MerchantCategory.geofenceRadiusMeters overrides it per stop.
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
  /** This stop's own radius. Falls back to GEOFENCE_RADIUS_METERS when absent. */
  radiusMeters?: number | null;
  /**
   * How long a stop of this kind usually takes, at the 80th percentile. Used
   * only to decide whether a completed dwell ran long; null where the category
   * has no learned figure yet, in which case nothing is judged.
   */
  dwellP80Seconds?: number | null;
}

/** How close a rider must be for this particular stop to count as reached. */
export function radiusOf(stop: Pick<GeofenceStop, "radiusMeters">): number {
  const radius = stop.radiusMeters;
  return typeof radius === "number" && radius > 0 ? radius : GEOFENCE_RADIUS_METERS;
}

export interface GeofenceTransition {
  pinpointId: number;
  kind: "arrived" | "departed";
  at: Date;
  dwellSeconds?: number;
}

export interface StopMismatch {
  // The unvisited stop this dwell was most likely meant to satisfy.
  pinpointId: number;
  pinnedStoreName: string;
  observedPlaceId: string;
  observedPlaceName: string;
  metersFromPinnedStop: number;
  at: Date;
}

/**
 * The single stop a fix belongs to: the nearest one whose radius contains it,
 * or null when it is inside none.
 *
 * Overlapping radii are unavoidable at 75 m in this city (see the constant
 * above), and without this a fix inside two circles counted as presence at
 * *both* — so a rider parked between Jollibee Main and Greenwich could register
 * an arrival at a store they never entered, and write a dwell observation that
 * poisons that category's percentiles for every future ETA.
 *
 * Nearest-wins keeps the generous radius while making each fix mean one place.
 */
function ownerOf(point: GeofencePoint, stops: GeofenceStop[]): number | null {
  let best: { id: number; meters: number } | null = null;

  for (const stop of stops) {
    const meters = haversineDistanceKm(point, stop) * 1000;
    if (meters > radiusOf(stop)) continue;

    // Compared by absolute distance, not by how deep into each radius the fix
    // sits. A supermarket with a wide circle must not out-claim a carinderia
    // the rider is standing directly outside.
    if (!best || meters < best.meters) best = { id: stop.id, meters };
  }

  return best?.id ?? null;
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

  // Resolve ownership once for the whole batch rather than per stop, so every
  // stop below reasons about the same partition of the breadcrumb.
  const owners = new Map<GeofencePoint, number | null>(
    points.map((point) => [point, ownerOf(point, stops)])
  );
  const ownedBy = (point: GeofencePoint, stopId: number) => owners.get(point) === stopId;

  for (const stop of stops) {
    if (stop.departedAt) continue;

    let arrivedAt = stop.arrivedAt;

    if (!arrivedAt) {
      const firstInside = points.find((point) => ownedBy(point, stop.id));
      if (!firstInside) continue;

      // Require sustained presence so a drive-past doesn't register as a visit.
      const lastInsideRun = points
        .filter((point) => point.recordedAt >= firstInside.recordedAt && ownedBy(point, stop.id))
        .pop();
      const presenceSeconds = lastInsideRun
        ? (lastInsideRun.recordedAt.getTime() - firstInside.recordedAt.getTime()) / 1000
        : 0;

      // The only fix inside so far may simply be the newest one — the rider has
      // just pulled up. Accept it and let a later batch confirm; a false arrival
      // self-corrects, whereas a missed one loses the dwell observation entirely.
      const stillInsideAtEnd = ownedBy(points[points.length - 1], stop.id);
      if (presenceSeconds < MIN_PRESENCE_SECONDS && !stillInsideAtEnd) continue;

      arrivedAt = firstInside.recordedAt;
      const changed = await pinpointRepository.markArrived(stop.id, arrivedAt);
      if ((changed?.count ?? 0) === 0) {
        // A manual arrival or another batch won. Base dwell on the persisted
        // stamp, and do not announce the same arrival a second time.
        const persisted = (await pinpointRepository.findByErrandId(errandId)).find((pin) => pin.id === stop.id);
        if (!persisted?.arrivedAt) continue;
        arrivedAt = persisted.arrivedAt;
      } else {
        transitions.push({ pinpointId: stop.id, kind: "arrived", at: arrivedAt });
        void storeAutoCorrectionService.autoCorrectStoreCoordinates({
          errandId,
          stop,
          arrivalPoint: firstInside,
        });
      }
    }

    // Departure: the first fix after arrival that this stop no longer owns —
    // either outside every radius, or now nearer a different stop. The second
    // case matters on a tight block, where a rider crossing to the shop next
    // door has certainly left this one.
    const since = arrivedAt as Date;
    const firstOutside = points.find((point) => point.recordedAt > since && !ownedBy(point, stop.id));
    if (!firstOutside) continue;

    // Leaving needs the rider to have been seen there. An arrival can also be
    // the rider's own tap ("GPS not detecting? Confirm Arrival",
    // pinpointArrivalService), made precisely when no fix is inside the
    // circle, and under the rule above the next fix outside it, seconds later,
    // was taken as the rider leaving: a departure while they were still
    // shopping, a dwell of a few seconds in the learning data, and an ETA
    // promise frozen too early. So that rule holds only once a fix has placed
    // the rider at this stop since they arrived.
    const seenThere = await seenAtStopSince(errandId, stop, stops, points, ownedBy, since, firstOutside.recordedAt);

    let departure: GeofencePoint | undefined = firstOutside;
    if (!seenThere) {
      // Never seen inside: the phone's position is off by more than the
      // circle, and it is off in the same direction wherever the rider goes. So
      // they have left when they have moved a full radius from where the phone
      // put them at the moment of arrival.
      const anchor = await trackPointRepository.findNearestInTime(errandId, since);
      departure = anchor
        ? points.find(
            (point) =>
              point.recordedAt > since &&
              !ownedBy(point, stop.id) &&
              haversineDistanceKm(point, anchor) * 1000 > radiusOf(stop)
          )
        : undefined;
      if (!departure) continue;
    }

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
    //
    // Only a visit the GPS saw becomes a dwell observation. One that rests on a
    // tap measures from whenever the tap reached the server, which an offline
    // retry can put after the rider had already left, and these figures set
    // every future customer's ETA for the category.
    const already = await dwellObservationRepository.existsForPinpoint(stop.id);
    if (!already && dwellSeconds > 0 && seenThere) {
      // Whether this one ran long, decided as it is recorded.
      //
      // detectStalledStop already computes this while the rider is still inside
      // the shop, but it fires mid-dwell — there is no observation yet to mark,
      // so it emitted a socket event and returned, and the fact left no trace.
      // Judging it here, at the moment the dwell completes, is what makes the
      // pattern trendable afterwards.
      const typical = stop.dwellP80Seconds ?? null;
      const stalled = typical !== null && dwellSeconds > typical;

      await dwellObservationRepository.create({
        errandId,
        pinpointId: stop.id,
        categoryId: stop.categoryId,
        placeId: stop.placeId,
        dwellSeconds,
        arrivedAt: arrivedAt as Date,
        departedAt: departure.recordedAt,
        stalled,
      });
    }
  }

  return transitions;
}

/**
 * Whether a fix has placed the rider at this stop (owned by it, as ownerOf
 * decides) at any time from `since` up to `until`.
 *
 * The batch in hand is checked first, which settles the ordinary case with no
 * query: an arrival the GPS made in this same batch is itself such a fix. Only
 * when the batch has none is the stored trail asked, for an arrival made in an
 * earlier batch, or by the rider's own tap.
 */
async function seenAtStopSince(
  errandId: string,
  stop: GeofenceStop,
  stops: GeofenceStop[],
  points: GeofencePoint[],
  ownedBy: (point: GeofencePoint, stopId: number) => boolean,
  since: Date,
  until: Date
): Promise<boolean> {
  if (points.some((point) => point.recordedAt >= since && point.recordedAt < until && ownedBy(point, stop.id))) {
    return true;
  }
  const radius = radiusOf(stop);
  const latSpan = radius / METERS_PER_DEGREE_LATITUDE;
  const lonSpan = radius / (METERS_PER_DEGREE_LATITUDE * Math.max(0.01, Math.cos((stop.latitude * Math.PI) / 180)));
  const stored = await trackPointRepository.findInWindowNear(errandId, since, until, {
    minLatitude: stop.latitude - latSpan,
    maxLatitude: stop.latitude + latSpan,
    minLongitude: stop.longitude - lonSpan,
    maxLongitude: stop.longitude + lonSpan,
  });
  return stored.some((point) => ownerOf(point, stops) === stop.id);
}

const METERS_PER_DEGREE_LATITUDE = 111_320;

/**
 * Notices a rider settling somewhere that is not any of the pinned stops.
 *
 * The case this exists for: a dispatcher pins Jollibee Drive-Thru and the rider
 * goes to Jollibee Center instead. Those two are 440 m apart — far outside the
 * geofence — so applyGeofenceTransitions above sees nothing at all. Nothing
 * errors, no arrival is recorded, no dwell observation is written, and the ETA
 * keeps routing to a store the rider already left. The errand completes looking
 * perfectly normal, and the only trace is an arrivedAt that stayed null.
 *
 * This turns that silence into one recorded, dispatcher-visible fact. It is
 * deliberately observational: it changes no status and blocks nothing, because a
 * rider at the wrong branch still has an errand to finish.
 *
 * Mirrors etaService.detectStalledStop — same fire-and-forget call site in
 * trackingService, same errand-room event, same "report the first one and stop".
 */
export async function detectStopMismatch(
  errandId: string,
  points: GeofencePoint[]
): Promise<StopMismatch | null> {
  if (points.length === 0) return null;

  const stops = await pinpointRepository.findByErrandId(errandId);
  const outstanding = stops.filter((stop) => !stop.arrivedAt && !stop.departedAt);
  if (outstanding.length === 0) return null;

  const geofenceStops: GeofenceStop[] = stops.map((stop) => ({
    id: stop.id,
    latitude: stop.latitude,
    longitude: stop.longitude,
    categoryId: stop.categoryId,
    placeId: stop.placeId,
    arrivedAt: stop.arrivedAt,
    departedAt: stop.departedAt,
  }));

  const dwell = findUnpinnedDwell(points, geofenceStops);
  if (!dwell) return null;

  const observed = await placeRepository.findNearest(dwell, GEOFENCE_RADIUS_METERS);
  if (!observed) return null;

  // A stop the dispatcher pinned from the catalogue carries its placeId. One
  // dropped on a bare map does not, and cannot be compared — treating an
  // uncatalogued pin as a mismatch would fire on every off-catalogue errand.
  const pinnedPlaceIds = new Set(
    stops.map((stop) => stop.placeId).filter((id): id is string => Boolean(id))
  );
  if (pinnedPlaceIds.size === 0) return null;
  if (pinnedPlaceIds.has(observed.place.id)) return null;

  // Attribute it to the nearest stop still outstanding — the one the rider was
  // most plausibly trying to reach.
  const target = outstanding
    .map((stop) => ({ stop, meters: haversineDistanceKm(dwell, stop) * 1000 }))
    .sort((a, b) => a.meters - b.meters)[0];

  // Report once. A rider parked at the wrong branch keeps uploading breadcrumbs
  // for as long as they are inside, and dispatch does not need the same alert
  // every minute.
  if (target.stop.mismatchDetectedAt) return null;

  const mismatch: StopMismatch = {
    pinpointId: target.stop.id,
    pinnedStoreName: target.stop.storeName,
    observedPlaceId: observed.place.id,
    observedPlaceName: observed.place.name,
    metersFromPinnedStop: Math.round(target.meters),
    at: dwell.recordedAt,
  };

  await pinpointRepository.markStopMismatch(target.stop.id, observed.place.id, dwell.recordedAt);

  logger.info(
    `Errand ${errandId}: rider dwelled at "${observed.place.name}" but stop ${target.stop.id} is pinned to "${target.stop.storeName}" (${mismatch.metersFromPinnedStop} m away).`
  );
  eventPublisher.emitToErrand(errandId, "errand:stop_mismatch", { errandId, ...mismatch });
  void notifyStaffAboutErrand("STOP_MISMATCH", errandId, (errand) => ({
    title: `Rider at the wrong store: ${observed.place.name}`,
    body: `${errand}: the rider stopped at ${observed.place.name}, ${mismatch.metersFromPinnedStop} m from the pinned ${target.stop.storeName ?? "store"}.`,
  }), { onceKey: `pin:${target.stop.id}` });

  return mismatch;
}

/**
 * The first point in a sustained stay that belongs to no pinned stop.
 *
 * Reuses the same presence rule as arrival detection rather than inventing a
 * second threshold: a rider held at a junction for a minute is not "at" a place,
 * and neither is one riding past a store on the way to another.
 */
function findUnpinnedDwell(
  points: GeofencePoint[],
  stops: GeofenceStop[]
): GeofencePoint | null {
  const unpinned = points.filter((point) => ownerOf(point, stops) === null);
  if (unpinned.length === 0) return null;

  for (let i = 0; i < unpinned.length; i++) {
    const anchor = unpinned[i];
    const nearAnchor = unpinned
      .slice(i)
      .filter((point) => haversineDistanceKm(anchor, point) * 1000 <= GEOFENCE_RADIUS_METERS);

    const last = nearAnchor[nearAnchor.length - 1];
    const heldSeconds = (last.recordedAt.getTime() - anchor.recordedAt.getTime()) / 1000;

    // Same allowance as arrival: the rider may have only just pulled up, and a
    // later batch will confirm. Being still there at the end of the batch counts.
    const stillThere = last === unpinned[unpinned.length - 1] && last === points[points.length - 1];
    if (heldSeconds >= MIN_PRESENCE_SECONDS || stillThere) return anchor;
  }

  return null;
}
