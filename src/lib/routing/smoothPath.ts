import { haversineDistanceKm, type GeoPoint } from "../geo.js";

/**
 * Rounds the corners of a route line so it curves through a turn.
 *
 * The geometry OSRM returns already follows the road: a 7 km Tacurong route
 * comes back as 133 points at 43 m median spacing, and the handful of sharp
 * vertices in it are real street corners. Drawn as-is, those corners are hard
 * angles. A delivery map is expected to sweep through them, which is a
 * rendering convention rather than better data — so it is applied here, once,
 * for every client rather than reimplemented per map.
 *
 * The cut is capped at a fraction of each adjacent segment, and that cap is the
 * whole reason this is safe. Chaikin's algorithm — the usual answer — cuts at a
 * flat 25% of every segment, which on the 290 m straights this very route
 * contains would pull the drawn line some 70 m off the carriageway. Bounding the
 * cut keeps the curve inside a lane while still reading as a curve.
 *
 * Never used for measurement. Distance and duration stay exactly as the routing
 * engine reported them; this changes only what is drawn.
 */

/** How far back from a corner the curve begins, at most. About a lane width. */
export const TURN_RADIUS_METERS = 12;

/**
 * Never consume more than this share of a segment, so a curve cannot swallow a
 * short block whole and cut the corner off the road entirely.
 */
const MAX_SEGMENT_SHARE = 0.4;

/** Below this the vertex is not a turn, and rounding it would only add points. */
const MIN_TURN_DEGREES = 10;

/** Points drawn along each corner. Four is smooth at city zoom and cheap. */
const ARC_STEPS = 4;

const metresBetween = (a: GeoPoint, b: GeoPoint) => haversineDistanceKm(a, b) * 1000;

/**
 * A point `metres` along the way from `from` toward `to`.
 *
 * Linear in lat/lng rather than a true geodesic step: over the ≤12 m this is
 * ever asked for, the difference is millimetres.
 */
function stepToward(from: GeoPoint, to: GeoPoint, metres: number): GeoPoint {
  const length = metresBetween(from, to);
  if (length === 0) return { latitude: from.latitude, longitude: from.longitude };

  const t = Math.min(1, metres / length);
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * t,
    longitude: from.longitude + (to.longitude - from.longitude) * t,
  };
}

/** Interior angle at `vertex`, in degrees. 180 is dead straight. */
function turnAngleDegrees(before: GeoPoint, vertex: GeoPoint, after: GeoPoint): number {
  // Longitude is compressed by latitude; without correcting for it an
  // east-west turn measures shallower than it is. Tacurong sits near the
  // equator where the factor is close to 1, but the code should not depend on
  // where it happens to be deployed.
  const scale = Math.cos((vertex.latitude * Math.PI) / 180);

  const ax = (before.longitude - vertex.longitude) * scale;
  const ay = before.latitude - vertex.latitude;
  const bx = (after.longitude - vertex.longitude) * scale;
  const by = after.latitude - vertex.latitude;

  const magA = Math.hypot(ax, ay);
  const magB = Math.hypot(bx, by);
  if (magA === 0 || magB === 0) return 180;

  const cosine = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (magA * magB)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/** Quadratic Bézier from `start` to `end`, bending toward `control`. */
function arc(start: GeoPoint, control: GeoPoint, end: GeoPoint): GeoPoint[] {
  const points: GeoPoint[] = [];

  for (let step = 0; step <= ARC_STEPS; step++) {
    const t = step / ARC_STEPS;
    const inverse = 1 - t;
    const a = inverse * inverse;
    const b = 2 * inverse * t;
    const c = t * t;

    points.push({
      latitude: a * start.latitude + b * control.latitude + c * end.latitude,
      longitude: a * start.longitude + b * control.longitude + c * end.longitude,
    });
  }

  return points;
}

/**
 * Returns the same path with its corners rounded.
 *
 * Endpoints are preserved exactly — a route must still start where the rider is
 * and end at the customer's door. Straight runs come back untouched.
 */
export function smoothPath(path: GeoPoint[], radiusMeters = TURN_RADIUS_METERS): GeoPoint[] {
  if (!Array.isArray(path) || path.length < 3 || radiusMeters <= 0) {
    return Array.isArray(path) ? [...path] : [];
  }

  const smoothed: GeoPoint[] = [path[0]];

  for (let i = 1; i < path.length - 1; i++) {
    const before = path[i - 1];
    const vertex = path[i];
    const after = path[i + 1];

    const incoming = metresBetween(before, vertex);
    const outgoing = metresBetween(vertex, after);

    // A duplicated point has no direction to turn through; drop it rather than
    // emitting a degenerate arc.
    if (incoming === 0 || outgoing === 0) continue;

    if (turnAngleDegrees(before, vertex, after) > 180 - MIN_TURN_DEGREES) {
      smoothed.push(vertex);
      continue;
    }

    const cut = Math.min(
      radiusMeters,
      incoming * MAX_SEGMENT_SHARE,
      outgoing * MAX_SEGMENT_SHARE
    );

    smoothed.push(
      ...arc(stepToward(vertex, before, cut), vertex, stepToward(vertex, after, cut))
    );
  }

  smoothed.push(path[path.length - 1]);
  return smoothed;
}
