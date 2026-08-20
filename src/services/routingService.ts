import * as routingProvider from "../lib/routing/resilientRoutingService.js";
import type { GeoPoint, RouteResult } from "../lib/routing/types.js";
import { ServiceError } from "./ServiceError.js";

// The wire shape POST /api/routing/directions has always returned. Both mobile
// apps consume exactly these fields (see useLiveRoute.ts in CustomerApp and
// RiderMobileApp), so it is frozen — `provider` and `degraded` are additive
// only, and clients that ignore them keep working unchanged.
export interface DirectionsResponse {
  coordinates: GeoPoint[];
  pickupLegCoordinates: GeoPoint[] | null;
  deliveryLegCoordinates: GeoPoint[] | null;
  distanceMeters: number;
  durationSeconds: number;
  provider: string;
  degraded: boolean;
}

// Leg 0 is the rider's run to the first store; everything after it is the
// delivery run. The two are drawn in different colours on the customer's map,
// which is why they're split here rather than returned as one flat polyline.
function splitLegs(result: RouteResult): Pick<
  DirectionsResponse,
  "pickupLegCoordinates" | "deliveryLegCoordinates"
> {
  const pickup = result.legs.length > 0 ? result.legs[0].coordinates : [];
  const delivery = result.legs.slice(1).flatMap((leg) => leg.coordinates);

  return {
    pickupLegCoordinates: pickup.length > 0 ? pickup : null,
    deliveryLegCoordinates: delivery.length > 0 ? delivery : null,
  };
}

export async function getDirections(
  origin: GeoPoint,
  destination: GeoPoint,
  waypoints: GeoPoint[] = []
): Promise<DirectionsResponse> {
  const result = await routingProvider.route([origin, ...waypoints, destination]);
  if (!result) {
    throw new ServiceError(503, "Routing is temporarily unavailable. Please try again shortly.");
  }

  return {
    coordinates: result.coordinates,
    ...splitLegs(result),
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
