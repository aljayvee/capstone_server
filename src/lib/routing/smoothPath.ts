import { haversineDistanceKm, type GeoPoint } from "../geo.js";

/**
 * Rounds the corners of a route line so it curves through a turn.
 *
 * The geometry OSRM returns already follows the road: a 7 km Tacurong route
 * comes back as 133 points at 43 m median spacing, and the sharp vertices in it
 * are real street corners. Drawn as-is, those corners are hard angles, and a
 * highway bend (a chain of 5-10 degree kinks, one per OSM node) reads as a
 * faceted zigzag. A delivery map is expected to sweep through both, which is a
 * rendering convention rather than better data — so it is applied here, once,
 * for every client rather than reimplemented per map.
 *
 * ## Circular fillets, sized by how far the line may leave the road
 *
 * Every bend is replaced by a true circular arc tangent to both road segments,
 * so a 90-degree street corner draws as a clean quarter circle and a highway
 * curve as one continuous sweep. The fillet size comes from a single rule: the
 * drawn line may never stray more than MAX_OFFSET_METERS from the road's
 * centreline. That one rule does the right thing at both extremes:
 *
 * - A 90-degree corner may only pull ~3.5 m inside the junction, which gives a
 *   fillet of about 8.5 m radius: visibly a curve, and about where a rider
 *   actually takes the turn.
 * - A 6-degree highway kink moves the line barely a metre however long its
 *   fillet is, so the fillet can span most of both neighbouring segments, and
 *   the arcs of consecutive kinks meet end to end into one smooth curve that
 *   still sits on the carriageway.
 *
 * The previous version drew quadratic Béziers capped at 10 m and skipped any
 * bend under 15 degrees. Every highway curve was a run of sub-15-degree kinks,
 * so none of them were smoothed at all.
 *
 * Never used for measurement. Distance and duration stay exactly as the routing
 * engine reported them; this changes only what is drawn.
 */

/**
 * The furthest the drawn line may sit from the road centreline, in metres.
 *
 * Half of a 7 m two-lane carriageway: the curve stays inside the road the rider
 * is on. This is the guarantee the "exact alignment" requirement rests on, and
 * the tests hold the implementation to it on a real route.
 */
export const MAX_OFFSET_METERS = 3.5;

/**
 * The longest a single fillet may run along either segment, in metres.
 *
 * Only reached on gentle bends between long segments, where the offset rule
 * alone would allow a curve hundreds of metres long. Past this length a curve
 * reads as a road drawn in the wrong place rather than as a smoothed one.
 */
const MAX_TANGENT_METERS = 40;

/**
 * The share of a segment each end's fillet may consume.
 *
 * Half, so the fillets at the two ends of a segment can meet but never overlap.
 * That meeting point is where consecutive highway kinks join into one curve.
 */
const MAX_SEGMENT_SHARE = 0.5;

/** Below this the vertex is not a bend worth drawing; it is passed through as-is. */
const MIN_DEFLECTION_DEGREES = 2;

/**
 * Beyond this the vertex is a turnaround, not a corner, and has no meaningful
 * fillet. It is kept exactly, since a rounded U-turn would draw the line across
 * the median.
 */
const MAX_DEFLECTION_DEGREES = 170;

/** Angular resolution of each arc: a 90-degree corner gets 12 facets. */
const DEGREES_PER_ARC_STEP = 7.5;

const EARTH_METRES_PER_DEGREE = 111_195;

interface Vec {
  x: number;
  y: number;
}

/**
 * A small local plane in metres, centred on one vertex.
 *
 * Equirectangular about the vertex. Over the ≤40 m a fillet ever spans, the
 * error against a true geodesic is well under a millimetre, and working in
 * metres is what makes "3.5 m from the centreline" something the arithmetic can
 * actually honour — in raw degrees, longitude is compressed by latitude and an
 * east-west turn would measure shallower than it is.
 */
function localPlane(origin: GeoPoint) {
  const lngScale = EARTH_METRES_PER_DEGREE * Math.cos((origin.latitude * Math.PI) / 180);
  return {
    toPlane: (point: GeoPoint): Vec => ({
      x: (point.longitude - origin.longitude) * lngScale,
      y: (point.latitude - origin.latitude) * EARTH_METRES_PER_DEGREE,
    }),
    toGeo: (vec: Vec): GeoPoint => ({
      latitude: origin.latitude + vec.y / EARTH_METRES_PER_DEGREE,
      longitude: origin.longitude + vec.x / lngScale,
    }),
  };
}

const metresBetween = (a: GeoPoint, b: GeoPoint) => haversineDistanceKm(a, b) * 1000;

/**
 * The circular arc replacing the corner at `vertex`, or null to keep the vertex.
 *
 * Returned points run from the tangent point on the incoming segment to the one
 * on the outgoing segment, both inclusive.
 */
function filletAt(
  before: GeoPoint,
  vertex: GeoPoint,
  after: GeoPoint,
  maxOffsetMeters: number
): GeoPoint[] | null {
  const plane = localPlane(vertex);
  const a = plane.toPlane(before);
  const b = plane.toPlane(after);

  const incoming = Math.hypot(a.x, a.y);
  const outgoing = Math.hypot(b.x, b.y);
  if (incoming === 0 || outgoing === 0) return null;

  // Direction of travel into and out of the vertex.
  const inDir = { x: -a.x / incoming, y: -a.y / incoming };
  const outDir = { x: b.x / outgoing, y: b.y / outgoing };

  const cross = inDir.x * outDir.y - inDir.y * outDir.x;
  const dot = Math.min(1, Math.max(-1, inDir.x * outDir.x + inDir.y * outDir.y));
  const deflection = Math.acos(dot);
  const deflectionDegrees = (deflection * 180) / Math.PI;

  if (deflectionDegrees < MIN_DEFLECTION_DEGREES || deflectionDegrees > MAX_DEFLECTION_DEGREES) {
    return null;
  }

  // For a fillet with tangent length T through deflection δ, the arc's midpoint
  // sits T·tan(δ/4) from the corner, so bounding that by the offset budget
  // bounds T. The other two caps keep it inside its own segments.
  const tangent = Math.min(
    maxOffsetMeters / Math.tan(deflection / 4),
    MAX_TANGENT_METERS,
    incoming * MAX_SEGMENT_SHARE,
    outgoing * MAX_SEGMENT_SHARE
  );
  if (!(tangent > 0)) return null;

  const radius = tangent / Math.tan(deflection / 2);
  const turn = cross >= 0 ? 1 : -1; // +1 left, -1 right

  const start = { x: -inDir.x * tangent, y: -inDir.y * tangent };
  // The centre lies off the incoming segment on the inside of the turn.
  const centre = {
    x: start.x + turn * -inDir.y * radius,
    y: start.y + turn * inDir.x * radius,
  };
  const startAngle = Math.atan2(start.y - centre.y, start.x - centre.x);

  const steps = Math.max(2, Math.ceil(deflectionDegrees / DEGREES_PER_ARC_STEP));
  const points: GeoPoint[] = [];
  for (let step = 0; step <= steps; step++) {
    const angle = startAngle + turn * deflection * (step / steps);
    points.push(
      plane.toGeo({
        x: centre.x + radius * Math.cos(angle),
        y: centre.y + radius * Math.sin(angle),
      })
    );
  }
  return points;
}

/**
 * Returns the same path with its corners rounded.
 *
 * Endpoints are preserved exactly — a route must still start where the rider is
 * and end at the customer's door. Straight runs come back untouched, and a
 * `maxOffsetMeters` of zero returns the path unchanged.
 */
export function smoothPath(path: GeoPoint[], maxOffsetMeters = MAX_OFFSET_METERS): GeoPoint[] {
  if (!Array.isArray(path) || path.length < 3 || !(maxOffsetMeters > 0)) {
    return Array.isArray(path) ? [...path] : [];
  }

  // A duplicated point has no direction to turn through. Dropped up front so
  // every vertex the loop sees has a real segment on each side.
  const cleaned: GeoPoint[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    if (metresBetween(cleaned[cleaned.length - 1], path[i]) > 0) cleaned.push(path[i]);
  }
  if (cleaned.length < 3) return cleaned;

  const smoothed: GeoPoint[] = [cleaned[0]];
  // Two fillets that each take half of the segment between them meet at the
  // same point; emitting it twice would draw a zero-length segment.
  const append = (point: GeoPoint) => {
    const last = smoothed[smoothed.length - 1];
    if (metresBetween(last, point) > 0.01) smoothed.push(point);
  };

  for (let i = 1; i < cleaned.length - 1; i++) {
    const arc = filletAt(cleaned[i - 1], cleaned[i], cleaned[i + 1], maxOffsetMeters);
    (arc ?? [cleaned[i]]).forEach(append);
  }
  // Pushed directly so the endpoint is the original coordinate object, exact.
  const end = cleaned[cleaned.length - 1];
  if (smoothed.length > 1 && metresBetween(smoothed[smoothed.length - 1], end) <= 0.01) smoothed.pop();
  smoothed.push(end);
  return smoothed;
}
