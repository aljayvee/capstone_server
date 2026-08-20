import { OSRM_BASE_URL } from "../../config/env.js";
import { logger } from "../logger.js";
import { haversineDistanceKm } from "../geo.js";
import { decodePolyline } from "./polyline.js";
import type {
  GeoPoint,
  MatchedPoint,
  MatchResult,
  MatrixResult,
  RouteLeg,
  RouteResult,
  RoutingProvider,
  TracePoint,
} from "./types.js";

// Generous enough for a remote VPS hop (the deployment target) without letting a
// hung upstream stall errand creation — the circuit breaker handles repeat failures.
const REQUEST_TIMEOUT_MS = 8000;

// osrm-routed refuses a /match trace longer than its --max-matching-size
// (default 100). A rider flushing a long offline backlog easily exceeds that,
// so traces are chunked. Verified against a live OSRM: a 12-point request came
// back "TooBig" on a server configured with a small limit.
const MAX_MATCH_POINTS = Number(process.env.OSRM_MAX_MATCH_POINTS) || 90;

// Consecutive chunks share this many points so the road choice at a chunk
// boundary is informed by where the rider actually came from.
const MATCH_CHUNK_OVERLAP = 2;

// A snap that relocates a fix further than this is not a correction, it is a
// guess onto the wrong road. Rejected per-point, keeping the honest raw fix.
//
// NOTE: OSRM's own `confidence` field is deliberately NOT used as the quality
// gate. Measured against a live engine, it reports 0.000 even for a trace
// sampled directly off a real road geometry unless timestamps are supplied —
// thresholding on it would silently disable map matching altogether.
const MAX_SNAP_METERS = 50;

// OSRM speaks lon,lat — the opposite of every other coordinate in this codebase.
// Confining the flip to this one helper is deliberate: it is the single most
// likely source of a silently-wrong route.
function toOsrmCoordinates(points: GeoPoint[]): string {
  return points.map((p) => `${p.longitude},${p.latitude}`).join(";");
}

function fromOsrmLocation(location: [number, number]): GeoPoint {
  return { latitude: location[1], longitude: location[0] };
}

// OSRM signals routing outcomes in-band via `code`, and — importantly — serves
// some of them with an HTTP error status: NoMatch comes back as HTTP 400 while
// NoRoute comes back as HTTP 200. Keying off response.ok alone would therefore
// classify a perfectly normal "this trace could not be snapped to a road" as a
// provider fault, trip the circuit breaker, and disable routing for every user
// for a minute. So the body is always parsed first and `code` is the authority.
//
// Codes that mean "healthy engine, no answer for this input" -> null (fall
// through to the next provider, breaker untouched).
const NO_ANSWER_CODES = new Set(["NoRoute", "NoMatch", "NoSegment", "NoTrips", "NoTable", "TooBig"]);

async function getJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const path = new URL(url).pathname.split("/").slice(0, 3).join("/");
  try {
    const response = await fetch(url, { signal: controller.signal });

    let data: any;
    try {
      data = await response.json();
    } catch {
      // Non-JSON body means we did not reach OSRM itself (proxy error page,
      // gateway timeout) — a genuine transport failure.
      throw new Error(`OSRM returned a non-JSON ${response.status} response for ${path}`);
    }

    if (data?.code === "Ok") return data;

    if (NO_ANSWER_CODES.has(data?.code)) {
      logger.info(`OSRM ${path} returned ${data.code} — no result for this input.`);
      return null;
    }

    // Invalid* codes are our bug (malformed URL, bad options), not the engine's.
    // Throwing keeps them loud rather than silently degrading to haversine.
    throw new Error(`OSRM ${path} error ${data?.code}: ${data?.message ?? "no detail"}`);
  } finally {
    clearTimeout(timer);
  }
}

// Self-hosted OSRM (see server/gis/docker-compose.osrm.yml). Primary provider:
// it is the only one that gives us a distance/duration matrix and map matching
// at no per-request cost, which is what proximity dispatch and breadcrumb
// snapping need.
export class OsrmRoutingProvider implements RoutingProvider {
  readonly name = "osrm" as const;

  isConfigured(): boolean {
    return Boolean(OSRM_BASE_URL);
  }

  async route(points: GeoPoint[]): Promise<RouteResult | null> {
    if (!this.isConfigured() || points.length < 2) return null;

    const url =
      `${OSRM_BASE_URL}/route/v1/driving/${toOsrmCoordinates(points)}` +
      `?overview=full&geometries=polyline&steps=true&alternatives=false`;
    const data = await getJson(url);
    const route = data?.routes?.[0];
    if (!route) return null;

    const legs: RouteLeg[] = (route.legs ?? []).map((leg: any) => ({
      distanceMeters: Math.round(leg.distance ?? 0),
      durationSeconds: Math.round(leg.duration ?? 0),
      coordinates: (leg.steps ?? []).flatMap((step: any) =>
        step?.geometry ? decodePolyline(step.geometry) : []
      ),
    }));

    return {
      distanceMeters: Math.round(route.distance ?? 0),
      durationSeconds: Math.round(route.duration ?? 0),
      coordinates: route.geometry ? decodePolyline(route.geometry) : [],
      encodedGeometry: route.geometry ?? null,
      legs,
      provider: this.name,
      degraded: false,
    };
  }

  async matrix(sources: GeoPoint[], destinations: GeoPoint[]): Promise<MatrixResult | null> {
    if (!this.isConfigured() || sources.length === 0 || destinations.length === 0) return null;

    // OSRM takes one flat coordinate list plus index arrays selecting which of
    // them act as sources and which as destinations.
    const all = [...sources, ...destinations];
    const sourceIndexes = sources.map((_, i) => i).join(";");
    const destinationIndexes = destinations.map((_, i) => i + sources.length).join(";");

    const url =
      `${OSRM_BASE_URL}/table/v1/driving/${toOsrmCoordinates(all)}` +
      `?sources=${sourceIndexes}&destinations=${destinationIndexes}&annotations=duration,distance`;
    const data = await getJson(url);
    if (!data?.durations) return null;

    return {
      durationsSeconds: data.durations,
      // `distances` requires OSRM built with the distance annotation; fall back
      // to a zero matrix rather than failing the whole call, since ranking only
      // needs durations.
      distancesMeters: data.distances ?? data.durations.map((row: number[]) => row.map(() => 0)),
      provider: this.name,
      degraded: false,
    };
  }

  async match(trace: TracePoint[]): Promise<MatchResult | null> {
    if (!this.isConfigured() || trace.length < 2) return null;

    const collected: MatchedPoint[] = [];
    const stride = MAX_MATCH_POINTS - MATCH_CHUNK_OVERLAP;

    for (let offset = 0; offset < trace.length; offset += stride) {
      const chunk = trace.slice(offset, offset + MAX_MATCH_POINTS);
      if (chunk.length < 2) break;

      const matched = await this.matchChunk(chunk, offset);
      if (matched) {
        for (const point of matched) {
          // Overlap means a boundary point can be matched twice; first wins.
          if (!collected.some((existing) => existing.sourceIndex === point.sourceIndex)) {
            collected.push(point);
          }
        }
      }
      if (chunk.length < MAX_MATCH_POINTS) break;
    }

    if (collected.length === 0) return null;
    collected.sort((a, b) => a.sourceIndex - b.sourceIndex);
    return { points: collected, provider: this.name };
  }

  private async matchChunk(chunk: TracePoint[], offset: number): Promise<MatchedPoint[] | null> {
    const params = new URLSearchParams({
      geometries: "polyline",
      overview: "false",
      // Lets OSRM discard the duplicate fixes a stationary phone emits, which is
      // exactly the noise we want gone before a breadcrumb is stored.
      tidy: "true",
      // Keeps an offline stretch from splitting the trace into separate matchings.
      gaps: "ignore",
    });

    // Timestamps must be non-decreasing integers; supply them only if every
    // point in the chunk has one, since a partial list is rejected outright.
    if (chunk.every((entry) => typeof entry.timestampSec === "number")) {
      let previous = -Infinity;
      const stamps = chunk.map((entry) => {
        const value = Math.max(Math.floor(entry.timestampSec as number), previous);
        previous = value;
        return value;
      });
      params.set("timestamps", stamps.join(";"));
    }

    const coordinates = toOsrmCoordinates(chunk.map((entry) => entry.point));
    const data = await getJson(`${OSRM_BASE_URL}/match/v1/driving/${coordinates}?${params.toString()}`);
    if (!data?.tracepoints) return null;

    const results: MatchedPoint[] = [];
    (data.tracepoints as (any | null)[]).forEach((tracepoint, index) => {
      if (!tracepoint?.location) return;
      const snapped = fromOsrmLocation(tracepoint.location);
      const snapMeters = haversineDistanceKm(chunk[index].point, snapped) * 1000;
      if (snapMeters > MAX_SNAP_METERS) return;
      results.push({ point: snapped, sourceIndex: offset + index, snapMeters });
    });

    return results.length > 0 ? results : null;
  }
}
