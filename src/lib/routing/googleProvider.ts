import { logger } from "../logger.js";
import { decodePolyline } from "./polyline.js";
import type {
  GeoPoint,
  MatchResult,
  MatrixResult,
  RouteLeg,
  RouteResult,
  RoutingProvider,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 6000;
const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";
const MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";

function apiKey(): string {
  return process.env.GOOGLE_MAPS_API_KEY || "";
}

function toLatLng(point: GeoPoint): string {
  return `${point.latitude},${point.longitude}`;
}

// Statuses that mean "Google is fine, there is simply no answer for this input".
// Everything else (REQUEST_DENIED, OVER_QUERY_LIMIT, UNKNOWN_ERROR) is a real
// provider fault and is thrown so the circuit breaker counts it.
const NO_ANSWER_STATUSES = new Set(["ZERO_RESULTS", "NOT_FOUND", "MAX_WAYPOINTS_EXCEEDED", "MAX_ROUTE_LENGTH_EXCEEDED"]);

async function getJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data: any = await response.json();
    if (data?.status === "OK") return data;

    if (NO_ANSWER_STATUSES.has(data?.status)) {
      logger.info(`Google Maps API returned ${data.status} — no route for this input.`);
      return null;
    }
    throw new Error(
      `Google Maps API error ${data?.status}: ${data?.error_message ?? "no detail"}`
    );
  } finally {
    clearTimeout(timer);
  }
}

// Hosted fallback for when self-hosted OSRM is unreachable. Billed per request,
// so it sits behind OSRM in the chain rather than in front of it.
export class GoogleRoutingProvider implements RoutingProvider {
  readonly name = "google" as const;

  isConfigured(): boolean {
    return Boolean(apiKey());
  }

  async route(points: GeoPoint[]): Promise<RouteResult | null> {
    if (!this.isConfigured() || points.length < 2) return null;

    const origin = points[0];
    const destination = points[points.length - 1];
    const waypoints = points.slice(1, -1);

    const params = new URLSearchParams({
      origin: toLatLng(origin),
      destination: toLatLng(destination),
      key: apiKey(),
    });
    if (waypoints.length > 0) {
      params.set("waypoints", waypoints.map(toLatLng).join("|"));
    }

    const data = await getJson(`${DIRECTIONS_URL}?${params.toString()}`);
    const route = data?.routes?.[0];
    if (!route) return null;

    const legs: RouteLeg[] = (route.legs ?? []).map((leg: any) => ({
      distanceMeters: leg.distance?.value ?? 0,
      durationSeconds: leg.duration?.value ?? 0,
      coordinates: (leg.steps ?? []).flatMap((step: any) =>
        step?.polyline?.points ? decodePolyline(step.polyline.points) : []
      ),
    }));

    const encodedGeometry: string | null = route.overview_polyline?.points ?? null;

    return {
      distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
      durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
      coordinates: encodedGeometry ? decodePolyline(encodedGeometry) : [],
      encodedGeometry,
      legs,
      provider: this.name,
      degraded: false,
    };
  }

  async matrix(sources: GeoPoint[], destinations: GeoPoint[]): Promise<MatrixResult | null> {
    if (!this.isConfigured() || sources.length === 0 || destinations.length === 0) return null;

    const params = new URLSearchParams({
      origins: sources.map(toLatLng).join("|"),
      destinations: destinations.map(toLatLng).join("|"),
      key: apiKey(),
    });

    const data = await getJson(`${MATRIX_URL}?${params.toString()}`);
    if (!data?.rows) return null;

    const durationsSeconds: number[][] = [];
    const distancesMeters: number[][] = [];

    for (const row of data.rows) {
      const durationRow: number[] = [];
      const distanceRow: number[] = [];
      for (const element of row.elements ?? []) {
        // Unreachable pairs come back as ZERO_RESULTS. Infinity keeps them last
        // in any min() ranking without pretending they're merely far away.
        const reachable = element?.status === "OK";
        durationRow.push(reachable ? element.duration?.value ?? Infinity : Infinity);
        distanceRow.push(reachable ? element.distance?.value ?? Infinity : Infinity);
      }
      durationsSeconds.push(durationRow);
      distancesMeters.push(distanceRow);
    }

    return { durationsSeconds, distancesMeters, provider: this.name, degraded: false };
  }

  // Google has no public map-matching endpoint (Roads API snapToRoads is a
  // separate product with its own key/billing and is not enabled here).
  // Returning null lets the resilient service fall through cleanly.
  async match(): Promise<MatchResult | null> {
    return null;
  }
}
