import * as routingProvider from "../lib/routing/resilientRoutingService.js";
import type { GeoPoint, OriginHint, RouteLeg, RouteResult, RouteStep } from "../lib/routing/types.js";
import { ServiceError } from "./ServiceError.js";
import { smoothPath } from "../lib/routing/smoothPath.js";
import { bestRoute, type RouteSelection } from "../lib/routing/bestRoute.js";
import { rememberRiderChoice, riderChoiceFor } from "../lib/routing/riderRouteChoice.js";
import { prisma } from "../lib/prisma.js";

// The wire shape POST /api/routing/directions returns. Both mobile apps
// consume these fields. All additive fields (`steps`, `legs`, `provider`, `degraded`)
// preserve 100% backward compatibility with legacy clients.
export interface DirectionsResponse {
  coordinates: GeoPoint[];
  pickupLegCoordinates: GeoPoint[] | null;
  deliveryLegCoordinates: GeoPoint[] | null;
  legs: RouteLeg[];
  steps: RouteStep[];
  distanceMeters: number;
  durationSeconds: number;
  provider: string;
  degraded: boolean;
  /**
   * Present when the caller asked for the fastest of both engines
   * (`choose: "fastest"`): which engine's path won, whose roads it is drawn
   * on, and both candidates' ETA and distance. Null otherwise.
   */
  selection: RouteSelection | null;
}

// Splits the route into Store pickup runs (Orange-Yellow) vs Customer delivery run (Pink-Red).
// When there are no store waypoints, the entire route is the customer delivery leg.
// Preserves exact GIS road geometry without artificial corner distortion.
function splitLegs(result: RouteResult, hasWaypoints: boolean): Pick<
  DirectionsResponse,
  "pickupLegCoordinates" | "deliveryLegCoordinates"
> {
  if (!hasWaypoints || result.legs.length <= 1) {
    return {
      pickupLegCoordinates: null,
      deliveryLegCoordinates: result.coordinates.length > 0 ? smoothPath(result.coordinates) : null,
    };
  }

  // All legs before the last leg are store pickup runs.
  const storePickupCoords = result.legs.slice(0, -1).flatMap((leg) => leg.coordinates);
  // The final leg is the run in to the customer delivery address.
  const customerDeliveryCoords = result.legs[result.legs.length - 1]?.coordinates ?? [];

  // Each leg is rounded on its own, so the join between the orange pickup line
  // and the blue delivery line stays exactly on the store it passes through.
  return {
    pickupLegCoordinates: storePickupCoords.length > 0 ? smoothPath(storePickupCoords) : null,
    deliveryLegCoordinates: customerDeliveryCoords.length > 0 ? smoothPath(customerDeliveryCoords) : null,
  };
}

export async function getDirections(
  origin: GeoPoint,
  destination: GeoPoint,
  waypoints: GeoPoint[] = [],
  // Whose roads to draw: "osrm" (OpenStreetMap) or "google". Omitted, the
  // configured chain decides, as it always has. Sugo Rider sends the map it is
  // showing, so the line comes from the same roads as the map under it.
  options: {
    prefer?: "osrm" | "google";
    choose?: "fastest";
    keep?: "osrm" | "google";
    // Who is asking. A rider's fastest-route verdict is remembered, so the
    // customer watching that rider's errand is shown the same map and line.
    caller?: { id: number; role: string };
    // The errand a customer is tracking; with it, the rider's verdict is reused.
    errandId?: string;
    // Which way the rider at `origin` is riding (originHintFor), so the route
    // starts on that road and not merely the nearest one.
    origin?: OriginHint;
  } = {}
): Promise<DirectionsResponse> {
  // Only the origin is snapped. It is the one point in the request that is a
  // live GPS fix — the waypoints are dispatcher-pinned VerifiedPlace coordinates
  // and the destination is a customer's deliberately-placed pin, both of which
  // are already where they are meant to be. Snapping those would drag a delivery
  // point out to the nearest road and quietly change where the rider is sent.
  //
  // It would also be redundant even where it seemed safe: Google, the active
  // provider, already snaps every endpoint onto its own road graph internally
  // when computing a route. Pre-snapping with OSRM's separate, smaller,
  // self-hosted graph and handing that point to Google risks the two engines
  // disagreeing about which road is nearest, for no benefit — Google was never
  // going to draw a line through a building on its own.
  //
  // Returns null when no provider can snap (OSRM not configured) or when the
  // nearest road is too far to move the fix honestly, in which case the raw
  // coordinate is used and behaviour is unchanged.
  //
  // Not at all when Google is asked for: a fix snapped onto OSM's road and then
  // handed to Google starts Google's line on OSM's road, which on Google's map
  // is the very offset this option exists to remove. Google snaps for itself.
  //
  // Nor when both engines are asked ("fastest"): each takes the raw fix and
  // snaps it onto its own roads, which is what makes their lines native.
  let result: RouteResult | null = null;
  let selection: RouteSelection | null = null;

  if (options.choose === "fastest") {
    let keep = options.keep;
    let drawOn = options.prefer;
    // A customer tracking an errand gets the rider's own verdict: the same
    // engine's path, on the same map, unless their app can only show Google.
    const riderChoice = await riderChoiceForErrand(options.errandId, options.caller);
    if (riderChoice) {
      keep = riderChoice.chosen as "osrm" | "google";
      drawOn = options.prefer ?? (riderChoice.drawnWith as "osrm" | "google");
    }

    const best = await bestRoute([origin, ...waypoints, destination], drawOn, { keep, origin: options.origin });
    if (best) {
      result = best.route;
      selection = best.selection;
      if (options.caller && String(options.caller.role).toUpperCase() === "RIDER") {
        rememberRiderChoice(options.caller.id, best.selection);
      }
    }
  }

  if (!result) {
    const snappedOrigin =
      options.prefer === "google" || options.choose === "fastest"
        ? origin
        : (await routingProvider.snap(origin, options.origin)) ?? origin;

    result = await routingProvider.route([snappedOrigin, ...waypoints, destination], {
      prefer: options.prefer,
      origin: options.origin,
    });
  }
  if (!result) {
    throw new ServiceError(503, "Routing is temporarily unavailable. Please try again shortly.");
  }

  const hasWaypoints = waypoints.length > 0;

  return {
    // Corners rounded for drawing only. distanceMeters and durationSeconds below
    // are the engine's own numbers and are never derived from this line — the
    // fare must not move because a corner was drawn differently.
    coordinates: smoothPath(result.coordinates),
    ...splitLegs(result, hasWaypoints),
    legs: result.legs,
    steps: result.steps || [],
    distanceMeters: result.distanceMeters,
    durationSeconds: result.durationSeconds,
    provider: result.provider,
    degraded: result.degraded,
    selection,
  };
}

// Above this speed a phone's GPS heading is its direction of travel; below it,
// the heading is noise and would pin the route to a random road.
export const ORIGIN_HINT_MIN_SPEED_MPS = 2;
// A road may point this far from the rider's heading and still be the one
// they are on: bends and GPS heading error, but never the cross street at 90.
export const ORIGIN_HINT_BEARING_RANGE = 45;

/**
 * The direction hint for a route's origin, from what Sugo Rider sends about
 * its own fix, or undefined when there is nothing trustworthy to send: no
 * heading, or a rider too slow for the heading to mean anything. Look for the
 * road within twice the fix's accuracy, between 25 and 60 m.
 */
export function originHintFor(input: {
  heading?: number;
  speedMps?: number;
  accuracyMeters?: number;
}): OriginHint | undefined {
  const { heading, speedMps, accuracyMeters } = input;
  if (typeof heading !== "number" || !Number.isFinite(heading) || heading < 0) return undefined;
  if (typeof speedMps !== "number" || !Number.isFinite(speedMps) || speedMps < ORIGIN_HINT_MIN_SPEED_MPS) {
    return undefined;
  }
  const accuracy = typeof accuracyMeters === "number" && accuracyMeters > 0 ? accuracyMeters : 20;
  return {
    bearingDeg: heading % 360,
    bearingRange: ORIGIN_HINT_BEARING_RANGE,
    radiusMeters: Math.min(60, Math.max(25, accuracy * 2)),
  };
}

// The verdict of the rider working `errandId`, when the caller may watch that
// errand (its customer, or staff) and the rider has one recent enough.
async function riderChoiceForErrand(
  errandId: string | undefined,
  caller: { id: number; role: string } | undefined
) {
  if (!errandId || !caller) return null;
  const role = String(caller.role).toUpperCase();
  if (role === "RIDER") return null;
  const errand = await prisma.errand.findUnique({
    where: { id: errandId },
    select: { riderId: true, customerId: true },
  });
  if (!errand?.riderId) return null;
  if (role === "CUSTOMER" && errand.customerId !== caller.id) return null;
  return riderChoiceFor(errand.riderId);
}

// Total road-network distance across an ordered stop list plus the final leg to
// the delivery point — the routing-backed replacement for geo.totalRouteDistanceKm
// in fee calculation. Returns null (not 0) when a route genuinely can't be
// determined, so callers can tell "no stops yet" from "2 km".
export async function routeDistanceKm(
  stops: GeoPoint[],
  destination: GeoPoint | null
): Promise<{ distanceKm: number; result: RouteResult } | null> {
  const points = destination ? [...stops, destination] : stops;
  if (points.length < 2) return null;

  const result = await routingProvider.route(points);
  if (!result) return null;

  return { distanceKm: result.distanceMeters / 1000, result };
}
