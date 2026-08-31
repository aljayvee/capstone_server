import * as routingProvider from "../lib/routing/resilientRoutingService.js";
import type { GeoPoint, RouteLeg, RouteResult, RouteStep } from "../lib/routing/types.js";
import { ServiceError } from "./ServiceError.js";
import { smoothPath } from "../lib/routing/smoothPath.js";

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
  waypoints: GeoPoint[] = []
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
  const snappedOrigin = (await routingProvider.snap(origin)) ?? origin;

  const result = await routingProvider.route([snappedOrigin, ...waypoints, destination]);
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
  };
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
