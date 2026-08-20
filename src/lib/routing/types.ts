import type { GeoPoint } from "../geo.js";

export type { GeoPoint };

// Which adapter actually answered. Surfaced all the way to the HTTP response so
// clients (and the ETA engine) can tell a real road-network route from a
// synthesised fallback instead of treating every number as equally trustworthy.
export type RoutingProviderName = "osrm" | "google" | "haversine";

export interface RouteLeg {
  distanceMeters: number;
  durationSeconds: number;
  // Decoded coordinates for this leg only. Empty when the provider can't split
  // per-leg geometry (the haversine fallback returns the two endpoints).
  coordinates: GeoPoint[];
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  // Full route geometry, decoded. The encoded form travels separately in
  // `encodedGeometry` so it can be persisted on Errand.routeGeometry without
  // re-encoding.
  coordinates: GeoPoint[];
  encodedGeometry: string | null;
  legs: RouteLeg[];
  provider: RoutingProviderName;
  // True when the numbers are estimated rather than measured against a road
  // network. Callers MUST widen any promise they build on a degraded result —
  // see etaService's range widening.
  degraded: boolean;
}

// Row-major durations/distances from sources to destinations, matching the
// order of the arrays passed in. Used by proximity dispatch to rank candidate
// riders by real travel time in a single call.
export interface MatrixResult {
  durationsSeconds: number[][];
  distancesMeters: number[][];
  provider: RoutingProviderName;
  degraded: boolean;
}

// One raw GPS fix awaiting map matching. `timestampSec` is optional but worth
// supplying: OSRM uses timing to disambiguate which road a trace belongs to,
// and without it the engine reports a confidence of 0 for even a perfect match.
export interface TracePoint {
  point: GeoPoint;
  timestampSec?: number;
}

export interface MatchedPoint {
  point: GeoPoint;
  // Index into the input trace this matched point corresponds to. Providers may
  // drop points they can't confidently snap, so this is not always dense.
  sourceIndex: number;
  // How far the engine moved this fix to put it on a road, in metres. The
  // caller uses this to decide whether the snap is trustworthy.
  snapMeters: number;
}

export interface MatchResult {
  points: MatchedPoint[];
  provider: RoutingProviderName;
}

// One adapter per routing engine (Adapter pattern, per AGENTS.md 3.2/4.3 —
// third-party services are always wrapped, never called inline).
//
// Every method returns null rather than throwing when the provider simply
// cannot answer (unsupported operation, no route, upstream error). The
// resilient service treats null as "try the next provider"; genuine
// programming errors still throw.
export interface RoutingProvider {
  readonly name: RoutingProviderName;
  // True when the adapter has everything it needs to be called at all (API key
  // present, base URL configured). An unconfigured provider is skipped silently
  // instead of burning a failed request on every call.
  isConfigured(): boolean;
  route(points: GeoPoint[]): Promise<RouteResult | null>;
  matrix(sources: GeoPoint[], destinations: GeoPoint[]): Promise<MatrixResult | null>;
  match(trace: TracePoint[]): Promise<MatchResult | null>;
}
