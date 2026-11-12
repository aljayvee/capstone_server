import type { GeoPoint } from "../geo.js";

/**
 * The line each rider is following right now, as last calculated for them.
 *
 * Sugo Rider keeps a route for as long as the rider follows it and asks for a
 * new one only when they leave it for another street (its reroutePolicy.ts).
 * Nobody else was told. The customer's Track map calculated a line of its own,
 * again on every few metres the rider moved, and the dispatcher's fleet map
 * drew the route stored when the fee was priced, which never changes. So when
 * a rider bypassed the route, the rider's phone said "Recalculating", the
 * customer's line quietly became a different one, and the dispatcher saw a pin
 * drifting off a line.
 *
 * Every answer to a rider's own route request is kept here, so the two
 * watchers can be handed that very line (services/riderRouteService.ts).
 *
 * The line runs from the rider to their next target only: the next store
 * while shopping, the customer's door once everything is bought. That is all
 * the rider app asks for.
 *
 * In memory, like riderRouteChoice.ts and for the same reason: it is rewritten
 * by the rider's next request. After a restart a watcher is told there is no
 * line and falls back to what it drew before this existed.
 */

/** A line older than this is not offered: the errand is long over. */
export const RIDER_ROUTE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** Two targets this close are the same stop, asked for twice. */
export const SAME_TARGET_METERS = 30;

/**
 * How far from the line they were following a rider must be, when they ask
 * for a new one to the same stop, for it to count as leaving the route. The
 * rider app reopened in the middle of a ride asks again from on the line, and
 * that is not a reroute.
 */
export const LEFT_ROUTE_METERS = 20;

/**
 * A rider this far from their stored line is no longer following it (their
 * app closed, or lost its connection, before it could ask for a new one). The
 * line is then not shown to anyone.
 */
export const OFF_STORED_ROUTE_METERS = 250;

export interface RiderLiveRoute {
  riderId: number;
  /** Rises with every new line for this rider. Holding the number is holding the line. */
  version: number;
  /** When this line was calculated, epoch ms. */
  at: number;
  /** When the rider last left a route to this same target, or null if they never have. */
  reroutedAt: number | null;
  /** Where the line ends: the next store, or the customer's door. */
  target: GeoPoint;
  /** The road line, corners rounded for drawing (routingService smoothPath). */
  coordinates: GeoPoint[];
  distanceMeters: number;
  durationSeconds: number;
  /** Whose roads the line follows: "osrm" or "google". */
  lineEngine: string;
}

export interface RiderRouteInput {
  riderId: number;
  /** Where the rider was when they asked. */
  origin: GeoPoint;
  target: GeoPoint;
  coordinates: GeoPoint[];
  distanceMeters: number;
  durationSeconds: number;
  lineEngine: string;
  /**
   * The rider only changed maps, so the same road was drawn again on the other
   * engine's roads (the request's `keep`). Never a reroute.
   */
  sameRoadRedrawn?: boolean;
}

const routes = new Map<number, RiderLiveRoute>();
let nextVersion = 1;

const EARTH_RADIUS_M = 6371000;
const DEG = Math.PI / 180;

/** Metres between two points. Flat-earth, which is exact enough at city scale. */
export function metresBetween(a: GeoPoint, b: GeoPoint): number {
  const scale = Math.cos(((a.latitude + b.latitude) / 2) * DEG);
  const dx = (b.longitude - a.longitude) * scale * DEG * EARTH_RADIUS_M;
  const dy = (b.latitude - a.latitude) * DEG * EARTH_RADIUS_M;
  return Math.hypot(dx, dy);
}

/** Metres from a point to the nearest part of a line. Infinity for an empty line. */
export function metresFromPath(point: GeoPoint, path: GeoPoint[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return metresBetween(point, path[0]);

  const scale = Math.cos(point.latitude * DEG);
  const px = point.longitude * scale;
  const py = point.latitude;
  let best = Number.POSITIVE_INFINITY;

  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i].longitude * scale;
    const ay = path[i].latitude;
    const vx = path[i + 1].longitude * scale - ax;
    const vy = path[i + 1].latitude - ay;
    const lengthSq = vx * vx + vy * vy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lengthSq));
    const nearest = {
      latitude: ay + vy * t,
      longitude: (ax + vx * t) / scale,
    };
    const distance = metresBetween(point, nearest);
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * Keeps the line just calculated for a rider. `rerouted` is true when it
 * replaces a line to the same stop that the rider had left: the moment the
 * rider's own screen said "Recalculating".
 */
export function rememberRiderRoute(
  input: RiderRouteInput,
  now: number = Date.now()
): { route: RiderLiveRoute; rerouted: boolean } {
  const previous = riderRouteFor(input.riderId, now);
  const sameTarget = previous != null && metresBetween(previous.target, input.target) <= SAME_TARGET_METERS;
  const rerouted =
    sameTarget &&
    !input.sameRoadRedrawn &&
    metresFromPath(input.origin, previous.coordinates) > LEFT_ROUTE_METERS;

  const route: RiderLiveRoute = {
    riderId: input.riderId,
    version: nextVersion++,
    at: now,
    // A new stop starts clean; the same stop keeps when it was last left.
    reroutedAt: rerouted ? now : sameTarget ? previous.reroutedAt : null,
    target: input.target,
    coordinates: input.coordinates,
    distanceMeters: input.distanceMeters,
    durationSeconds: input.durationSeconds,
    lineEngine: input.lineEngine,
  };
  routes.set(input.riderId, route);
  return { route, rerouted };
}

export function riderRouteFor(riderId: number, now: number = Date.now()): RiderLiveRoute | null {
  const route = routes.get(riderId);
  if (!route) return null;
  if (now - route.at > RIDER_ROUTE_MAX_AGE_MS) {
    routes.delete(riderId);
    return null;
  }
  return route;
}

/** Whether a rider at `position` is still on (or near) the line kept for them. */
export function isFollowing(route: RiderLiveRoute, position: GeoPoint): boolean {
  return metresFromPath(position, route.coordinates) <= OFF_STORED_ROUTE_METERS;
}

export function forgetRiderRoute(riderId: number): void {
  routes.delete(riderId);
}

/** Test seam. */
export function __resetRiderRoutes(): void {
  routes.clear();
  nextVersion = 1;
}
