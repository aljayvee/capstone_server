import { FALLBACK_AVG_SPEED_KMH, ROAD_DETOUR_FACTOR } from "../../config/env.js";
import { haversineDistanceKm } from "../geo.js";
import { encodePolyline } from "./polyline.js";
import type {
  GeoPoint,
  MatchResult,
  MatrixResult,
  RouteLeg,
  RouteResult,
  RoutingProvider,
} from "./types.js";

// Terminal fallback: needs no network and therefore can never be the reason a
// quote or an ETA fails outright. It is deliberately NOT raw straight-line
// distance — that under-states real travel badly enough that a fare computed
// from it disagrees with the route the customer watches on their own screen
// (the original defect this work exists to fix). The detour factor and average
// speed are calibrated for Tacurong's street grid and configurable via env.
//
// Everything it returns is flagged `degraded: true` so callers widen their
// promises instead of presenting an estimate as a measurement.
export class HaversineRoutingProvider implements RoutingProvider {
  readonly name = "haversine" as const;

  // Pure math — always available. This is what makes it a safe terminal entry
  // in ROUTING_PROVIDER_ORDER.
  isConfigured(): boolean {
    return true;
  }

  async route(points: GeoPoint[]): Promise<RouteResult | null> {
    if (points.length < 2) return null;

    const legs: RouteLeg[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const straightKm = haversineDistanceKm(points[i], points[i + 1]);
      const roadKm = straightKm * ROAD_DETOUR_FACTOR;
      legs.push({
        distanceMeters: Math.round(roadKm * 1000),
        durationSeconds: Math.round((roadKm / FALLBACK_AVG_SPEED_KMH) * 3600),
        coordinates: [points[i], points[i + 1]],
      });
    }

    return {
      distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
      durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
      coordinates: [...points],
      encodedGeometry: encodePolyline(points),
      legs,
      provider: this.name,
      degraded: true,
    };
  }

  async matrix(sources: GeoPoint[], destinations: GeoPoint[]): Promise<MatrixResult | null> {
    if (sources.length === 0 || destinations.length === 0) return null;

    const durationsSeconds: number[][] = [];
    const distancesMeters: number[][] = [];

    for (const source of sources) {
      const durationRow: number[] = [];
      const distanceRow: number[] = [];
      for (const destination of destinations) {
        const roadKm = haversineDistanceKm(source, destination) * ROAD_DETOUR_FACTOR;
        distanceRow.push(Math.round(roadKm * 1000));
        durationRow.push(Math.round((roadKm / FALLBACK_AVG_SPEED_KMH) * 3600));
      }
      durationsSeconds.push(durationRow);
      distancesMeters.push(distanceRow);
    }

    return { durationsSeconds, distancesMeters, provider: this.name, degraded: true };
  }

  // Map matching needs a road network. Without one the honest answer is "no",
  // which leaves the raw GPS trace stored unmatched (isMapMatched stays false).
  async match(): Promise<MatchResult | null> {
    return null;
  }
}
