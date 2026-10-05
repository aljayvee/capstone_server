import * as resilient from "./resilientRoutingService.js";
import { haversineDistanceKm } from "../geo.js";
import type { GeoPoint, OriginHint, RouteResult, RoutingProviderName } from "./types.js";

/**
 * The fastest of OSRM's and Google's routes, drawn on the map's own roads.
 *
 * Both engines are asked. The one with the lower ETA wins; when the two ETAs
 * are within ETA_TIE (a minute, or 5%), they are the same trip and the shorter
 * road wins instead. Each engine's ETA is its own: OSRM's is our model
 * (speeds capped at 60 km/h), Google's is traffic-aware. There is no fairer
 * single clock, because each engine's own route is by definition the fastest
 * by its own clock.
 *
 * The winning PATH is then redrawn on the roads of the map the rider is
 * looking at, so a Google-chosen path on the OpenStreetMap map still lies on
 * OpenStreetMap's roads, and the other way round. The redraw asks the map's
 * own engine to route through points taken from the middle of the winner's
 * road stretches, as pass-through points: same roads, native geometry. If the
 * redraw strays from the winner (a different road somewhere, more than
 * REDRAW_TOLERANCE longer or shorter) the winner is drawn as it is.
 *
 * Only Sugo Rider asks for this (routingService, `choose: "fastest"`).
 */

export type MapProvider = "osrm" | "google";

export interface RouteCandidate {
  provider: RoutingProviderName;
  durationSeconds: number;
  distanceMeters: number;
}

export interface RouteSelection {
  strategy: "fastest";
  /** Whose path won. */
  chosen: RoutingProviderName;
  /** Whose roads the drawn line follows. */
  drawnWith: RoutingProviderName;
  candidates: RouteCandidate[];
}

/** Two ETAs this close are the same trip; then the shorter road wins. */
export const ETA_TIE_SECONDS = 60;
export const ETA_TIE_RATIO = 0.05;

/** The map's own route counts as the winner's path when this close in length. */
export const SAME_PATH_RATIO = 0.02;

/** How far a redraw may differ in length from the path it copies. */
export const REDRAW_TOLERANCE = 0.05;

/**
 * A redraw must lie on the same roads as the path it copies, point by point,
 * both ways: within FOLLOW_METERS for at least FOLLOW_SHARE of the points.
 * Length alone let a redraw take a different road: 8% of a 45 km trip is
 * 3.6 km, room for a whole other route. 30 m absorbs the two companies
 * drawing the same road a few metres apart (a median 7 m around Banga) and
 * still tells one street from the next.
 */
export const FOLLOW_METERS = 30;
export const FOLLOW_SHARE = 0.95;
/** Points compared per line. Enough to catch a detour, cheap per request. */
const FOLLOW_SAMPLES = 200;

/** Pass-through points per redraw. Google bills more above ten. */
export const MAX_VIA_POINTS = 8;
/** Stretches shorter than this are too short to pin a road down. */
export const MIN_VIA_STEP_METERS = 120;
/** No pass-through point this close to either end, where the roads fan out. */
export const EDGE_CLEARANCE_METERS = 150;

function metres(a: GeoPoint, b: GeoPoint): number {
  return haversineDistanceKm(a, b) * 1000;
}

function lineLength(line: GeoPoint[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += metres(line[i - 1], line[i]);
  return total;
}

/** The point halfway along a line, measured along it. */
export function midpointAlong(line: GeoPoint[]): GeoPoint | null {
  if (line.length === 0) return null;
  if (line.length === 1) return line[0];
  let remaining = lineLength(line) / 2;
  for (let i = 1; i < line.length; i++) {
    const segment = metres(line[i - 1], line[i]);
    if (segment >= remaining) {
      const t = segment === 0 ? 0 : remaining / segment;
      return {
        latitude: line[i - 1].latitude + (line[i].latitude - line[i - 1].latitude) * t,
        longitude: line[i - 1].longitude + (line[i].longitude - line[i - 1].longitude) * t,
      };
    }
    remaining -= segment;
  }
  return line[line.length - 1];
}

/**
 * The lower ETA wins. Within the tie band the shorter distance wins. Straight
 * lines (degraded) never compete.
 */
export function pickFastest(routes: (RouteResult | null | undefined)[]): RouteResult | null {
  const usable = routes.filter(
    (route): route is RouteResult => Boolean(route) && !route!.degraded && route!.durationSeconds > 0
  );
  if (usable.length === 0) return null;

  return usable.reduce((best, next) => {
    const gap = next.durationSeconds - best.durationSeconds;
    const tieBand = Math.max(ETA_TIE_SECONDS, Math.min(best.durationSeconds, next.durationSeconds) * ETA_TIE_RATIO);
    if (Math.abs(gap) <= tieBand) {
      return next.distanceMeters < best.distanceMeters ? next : best;
    }
    return gap < 0 ? next : best;
  });
}

/**
 * Pass-through points that pin a route to its roads: the middle of its longest
 * stretches, in the order the route reaches them, clear of both ends.
 */
export function viaPointsAlong(route: RouteResult): GeoPoint[] {
  const total = route.distanceMeters;
  let travelled = 0;
  const candidates: { order: number; point: GeoPoint; length: number }[] = [];

  route.steps.forEach((step, order) => {
    const along = travelled + step.distanceMeters / 2;
    travelled += step.distanceMeters;
    if (step.distanceMeters < MIN_VIA_STEP_METERS) return;
    if (along < EDGE_CLEARANCE_METERS || total - along < EDGE_CLEARANCE_METERS) return;
    const point = midpointAlong(step.coordinates);
    if (point) candidates.push({ order, point, length: step.distanceMeters });
  });

  return candidates
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_VIA_POINTS)
    .sort((a, b) => a.order - b.order)
    .map((candidate) => candidate.point);
}

/**
 * The route with its times scaled to total `targetSeconds`, keeping each step's
 * share. A redraw carries the winner's ETA, and the rider's phone counts down
 * from the step times, so they must add up to the number that was compared.
 */
export function withTotalDuration(route: RouteResult, targetSeconds: number): RouteResult {
  if (!(route.durationSeconds > 0) || !(targetSeconds > 0)) return route;
  const factor = targetSeconds / route.durationSeconds;
  const scaleSteps = (steps: RouteResult["steps"]) =>
    steps.map((step) => ({ ...step, durationSeconds: Math.round(step.durationSeconds * factor) }));

  const legs = route.legs.map((leg) => {
    const steps = scaleSteps(leg.steps);
    return { ...leg, steps, durationSeconds: Math.round(leg.durationSeconds * factor) };
  });
  return {
    ...route,
    legs,
    steps: legs.length > 0 ? legs.flatMap((leg) => leg.steps) : scaleSteps(route.steps),
    durationSeconds: Math.round(targetSeconds),
  };
}

function withinRatio(a: number, b: number, ratio: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * ratio;
}

// Metres from `p` to the segment a-b, on a local flat plane (exact enough at
// the few-hundred-metre scale a "same road?" question is asked at).
function distanceToSegment(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const toRad = Math.PI / 180;
  const k = Math.cos(p.latitude * toRad) * 6371000 * toRad;
  const m = 6371000 * toRad;
  const ax = (a.longitude - p.longitude) * k, ay = (a.latitude - p.latitude) * m;
  const bx = (b.longitude - p.longitude) * k, by = (b.latitude - p.latitude) * m;
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function sample(line: GeoPoint[], count: number): GeoPoint[] {
  if (line.length <= count) return line;
  const step = (line.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => line[Math.round(i * step)]);
}

/** Share of `line`'s points lying within `meters` of `along`. */
function shareNear(line: GeoPoint[], along: GeoPoint[], meters: number): number {
  const points = sample(line, FOLLOW_SAMPLES);
  if (points.length === 0 || along.length < 2) return 0;
  let near = 0;
  for (const point of points) {
    for (let i = 1; i < along.length; i++) {
      if (distanceToSegment(point, along[i - 1], along[i]) <= meters) {
        near += 1;
        break;
      }
    }
  }
  return near / points.length;
}

/**
 * Whether two lines run along the same roads: each stays near the other for
 * nearly all its length. Both directions, so neither a detour off the path nor
 * a shortcut skipping part of it passes.
 */
export function followsPath(line: GeoPoint[], path: GeoPoint[]): boolean {
  return (
    shareNear(line, path, FOLLOW_METERS) >= FOLLOW_SHARE &&
    shareNear(path, line, FOLLOW_METERS) >= FOLLOW_SHARE
  );
}

function sameRoads(candidate: RouteResult, winner: RouteResult): boolean {
  return (
    withinRatio(candidate.distanceMeters, winner.distanceMeters, REDRAW_TOLERANCE) &&
    followsPath(candidate.coordinates, winner.coordinates)
  );
}

export async function bestRoute(
  points: GeoPoint[],
  // The map the line must be drawn on. Omitted, the winner is drawn on its own
  // roads and the caller shows that engine's map: Sugo Rider lets the server
  // decide, so the line and the map under it always come from one engine.
  drawOn: MapProvider | undefined,
  // `keep`: the engine whose path already won. Sent when the rider only
  // switched maps: the path must stay the same road, redrawn, rather than be
  // chosen again from wherever the rider happens to be standing. Also spares
  // the other engine's request.
  // `origin`: which way the rider is riding, so each engine starts on that
  // road rather than the nearest one (routingService.originHintFor).
  options: { keep?: MapProvider; origin?: OriginHint } = {}
): Promise<{ route: RouteResult; selection: RouteSelection } | null> {
  if (points.length < 2) return null;
  const hinted = options.origin ? { origin: options.origin } : undefined;

  let osrm: RouteResult | null = null;
  let google: RouteResult | null = null;
  if (options.keep) {
    const kept = await resilient.routeWith(options.keep, points, hinted);
    if (kept && !kept.degraded) {
      if (options.keep === "osrm") osrm = kept;
      else google = kept;
    }
  }
  if (!osrm && !google) {
    [osrm, google] = await Promise.all([
      resilient.routeWith("osrm", points, hinted),
      resilient.routeWith("google", points, hinted),
    ]);
  }
  const winner = pickFastest([osrm, google]);
  if (!winner) return null;

  const candidates: RouteCandidate[] = [osrm, google]
    .filter((route): route is RouteResult => Boolean(route) && !route!.degraded)
    .map((route) => ({
      provider: route.provider,
      durationSeconds: route.durationSeconds,
      distanceMeters: route.distanceMeters,
    }));
  const select = (drawnWith: RoutingProviderName): RouteSelection => ({
    strategy: "fastest",
    chosen: winner.provider,
    drawnWith,
    candidates,
  });

  if (!drawOn || winner.provider === drawOn) {
    return { route: winner, selection: select(winner.provider) };
  }

  // The map's own route is already the winner's path when it runs along the
  // same roads: draw it, with the winner's ETA, and ask nobody anything more.
  const own = drawOn === "osrm" ? osrm : google;
  if (
    own &&
    !own.degraded &&
    withinRatio(own.distanceMeters, winner.distanceMeters, SAME_PATH_RATIO) &&
    followsPath(own.coordinates, winner.coordinates)
  ) {
    return { route: withTotalDuration(own, winner.durationSeconds), selection: select(drawOn) };
  }

  // Redraw the winner's path on the map's own roads. Stops in between would
  // have to stay stops, which pass-through points cannot express, so only a
  // single run is redrawn; Sugo Rider only ever routes to the next target.
  if (points.length === 2) {
    const vias = viaPointsAlong(winner);
    if (vias.length > 0) {
      const redrawn = await resilient.routeWith(drawOn, [points[0], ...vias, points[1]], {
        passThrough: true,
        origin: options.origin,
      });
      if (redrawn && !redrawn.degraded && sameRoads(redrawn, winner)) {
        return { route: withTotalDuration(redrawn, winner.durationSeconds), selection: select(drawOn) };
      }
    }
  }

  // Could not be redrawn faithfully: the right path, on the other map's roads.
  return { route: winner, selection: select(winner.provider) };
}
