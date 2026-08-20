import { LRUCache } from "lru-cache";
import { ROUTING_PROVIDER_ORDER } from "../../config/env.js";
import { logger } from "../logger.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { GoogleRoutingProvider } from "./googleProvider.js";
import { HaversineRoutingProvider } from "./haversineProvider.js";
import { OsrmRoutingProvider } from "./osrmProvider.js";
import type {
  GeoPoint,
  MatchResult,
  MatrixResult,
  RouteResult,
  RoutingProvider,
  RoutingProviderName,
  TracePoint,
} from "./types.js";

const CACHE_TTL_MS = 20 * 1000;
const CACHE_MAX_ENTRIES = 500;

// Bounded, self-evicting. The previous implementation used a bare Map keyed by
// JSON.stringify of raw float coordinates with only a 60s sweep — an unbounded
// key space that leaked steadily under load.
const routeCache = new LRUCache<string, RouteResult>({ max: CACHE_MAX_ENTRIES, ttl: CACHE_TTL_MS });

// 5 decimal places is ~1.1 m — finer than GPS accuracy, so rounding here costs
// nothing in precision but collapses the near-identical keys a moving rider
// would otherwise generate on every single ping.
function cacheKey(points: GeoPoint[]): string {
  return points.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join(";");
}

const REGISTRY: Record<RoutingProviderName, () => RoutingProvider> = {
  osrm: () => new OsrmRoutingProvider(),
  google: () => new GoogleRoutingProvider(),
  haversine: () => new HaversineRoutingProvider(),
};

function buildChain(): RoutingProvider[] {
  const chain = ROUTING_PROVIDER_ORDER.map((name) => REGISTRY[name as RoutingProviderName])
    .filter(Boolean)
    .map((factory) => factory());

  // Guarantee a terminal provider that can never fail for lack of a network, so
  // routing degrades rather than erroring even on a completely misconfigured env.
  if (!chain.some((provider) => provider.name === "haversine")) {
    chain.push(new HaversineRoutingProvider());
  }
  return chain;
}

const providers = buildChain();
const breakers = new Map<RoutingProviderName, CircuitBreaker>(
  providers.map((provider) => [provider.name, new CircuitBreaker(provider.name)])
);

// Walks the configured chain in order and returns the first non-null answer.
//
// Only a *thrown* error counts against a provider's circuit breaker: adapters
// throw when the provider itself is unhealthy (unreachable, HTTP error, denied
// key) and return null when the provider answered perfectly well but has no
// result for this particular input (OSRM NoRoute/NoMatch, Google ZERO_RESULTS).
// Conflating the two would let a rider parked on an unmapped private lot trip
// the OSRM breaker and disable routing for every user for a minute.
async function attempt<T>(
  operation: string,
  call: (provider: RoutingProvider) => Promise<T | null>,
  // Some operations legitimately have no answer as a routine outcome — a
  // stationary rider's fixes have no road shape to map-match, and that happens
  // on every single store visit. Logging those at error level would bury real
  // faults in noise.
  nullIsRoutine = false
): Promise<T | null> {
  for (const provider of providers) {
    if (!provider.isConfigured()) continue;

    const breaker = breakers.get(provider.name);
    if (breaker && !breaker.canAttempt()) continue;

    try {
      const result = await call(provider);
      // Reaching here at all proves the provider is reachable and healthy, so
      // the breaker closes even when the answer was "no result".
      breaker?.recordSuccess();
      if (result !== null) return result;
    } catch (error) {
      logger.error(`Routing provider ${provider.name} failed during ${operation}:`, error);
      breaker?.recordFailure();
    }
  }

  if (nullIsRoutine) {
    logger.info(`No routing provider produced a ${operation} result.`);
  } else {
    logger.error(`No routing provider could serve ${operation}.`);
  }
  return null;
}

// Road-network route through every point in order. Cached briefly, since a
// moving rider re-requests a near-identical route many times a minute.
export async function route(points: GeoPoint[]): Promise<RouteResult | null> {
  if (points.length < 2) return null;

  const key = cacheKey(points);
  const cached = routeCache.get(key);
  if (cached) return cached;

  const result = await attempt("route", (provider) => provider.route(points));
  if (result) routeCache.set(key, result);
  return result;
}

// Travel time/distance from every source to every destination in one call.
// Deliberately uncached: its only caller is rider dispatch, where the sources
// are live positions that differ on every request anyway.
export async function matrix(
  sources: GeoPoint[],
  destinations: GeoPoint[]
): Promise<MatrixResult | null> {
  if (sources.length === 0 || destinations.length === 0) return null;
  return attempt("matrix", (provider) => provider.matrix(sources, destinations));
}

// Snaps a raw GPS trace onto the road network. Only OSRM implements this; the
// others return null, so this falls through to null when OSRM is unavailable
// and the caller stores the unmatched trace instead.
export async function match(trace: TracePoint[]): Promise<MatchResult | null> {
  if (trace.length < 2) return null;
  return attempt("match", (provider) => provider.match(trace), true);
}

// Exposed for diagnostics and tests.
export function configuredProviderNames(): RoutingProviderName[] {
  return providers.filter((provider) => provider.isConfigured()).map((provider) => provider.name);
}
