import type { GeoPoint } from "../lib/geo.js";
import { OsrmRoutingProvider } from "../lib/routing/osrmProvider.js";
import { distanceOutsideServiceAreaKm, isServiceAreaConfigured } from "../lib/serviceArea.js";
import { STORE_PIN_MAX_KM_BEYOND_BORDER } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * Whether a dispatcher may pin a store at a given spot.
 *
 * Three answers, in order of strictness:
 *
 * - **inside**: within the Tacurong service area. Nothing to say.
 * - **outside**: past the border, but on the road map the router has loaded.
 *   A rider can be routed there, so it is allowed, but the dispatcher is told
 *   how far past the border it is and must confirm. Buying across town lines
 *   is sometimes right (the only branch that stocks something) and always
 *   costs the customer distance.
 * - **blocked**: off the loaded road map, or past the optional km cap. The
 *   router cannot produce a route there, so the fare and ETA would silently
 *   fall back to a straight-line guess. Refused, in the browser and again when
 *   the pins are saved.
 *
 * ## Follows the loaded graph
 *
 * "Off the road map" is not a hard-coded box. It is asked of the OSRM engine
 * itself: /nearest always answers with the closest road the graph holds, so a
 * spot outside the extract comes back hundreds of metres or kilometres from
 * any road. When the graph grows (Banga was added on 2026-09-23), the allowed
 * area grows with it, with no change here.
 *
 * ## Fails open on the graph, never on the border
 *
 * When OSRM is not configured or unreachable, the graph half cannot be checked.
 * The spot is then judged on the border alone and reported `graphChecked:
 * false`, so an outage in an optional sidecar never stops dispatch, but a spot
 * past the border is still flagged.
 */

export type StoreLocationStatus = "inside" | "outside" | "blocked";

export type StoreLocationReason =
  | "inside_border"
  | "outside_border"
  | "off_road_map"
  | "beyond_cap";

export interface StoreLocationVerdict {
  status: StoreLocationStatus;
  reason: StoreLocationReason;
  /** Straight-line km past the service-area border. 0 when inside. */
  kmBeyondBorder: number;
  /** Metres to the nearest road in the loaded graph, when it could be asked. */
  nearestRoadMeters: number | null;
  /** False when the road graph could not be consulted. */
  graphChecked: boolean;
  /** One sentence for the dispatcher. Plain words, no em dashes. */
  message: string;
}

/**
 * Past this distance from every road, a spot is outside the graph.
 *
 * A shop sits on or beside a road. Even a store set back in a compound is
 * within a few hundred metres of one on the map, while a spot outside the
 * extract measures to the graph's edge, usually kilometres. One kilometre
 * separates the two cases with room to spare on both sides.
 */
export const OFF_GRAPH_METERS = 1000;

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; verdict: StoreLocationVerdict }>();

const osrm = new OsrmRoutingProvider();

const km = (value: number) => (value < 10 ? value.toFixed(1) : Math.round(value).toString());

async function nearestRoad(point: GeoPoint): Promise<number | null> {
  try {
    return await osrm.nearestRoadMeters(point);
  } catch (error) {
    logger.warn("Store location guard could not reach OSRM; judging on the border alone.", error);
    return null;
  }
}

export async function checkStoreLocation(point: GeoPoint): Promise<StoreLocationVerdict> {
  const lat = Number(point?.latitude);
  const lng = Number(point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      status: "blocked",
      reason: "outside_border",
      kmBeyondBorder: Infinity,
      nearestRoadMeters: null,
      graphChecked: false,
      message: "Invalid store coordinates.",
    };
  }

  const safePoint: GeoPoint = { latitude: lat, longitude: lng };
  // ~1 m buckets: two checks of one pin share an answer, two shops do not.
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.verdict;

  const kmBeyondBorder = isServiceAreaConfigured() ? distanceOutsideServiceAreaKm(safePoint) : 0;
  const nearestRoadMeters = await nearestRoad(safePoint);
  const graphChecked = nearestRoadMeters !== null;

  let verdict: StoreLocationVerdict;

  if (kmBeyondBorder > 0.1) {
    verdict = {
      status: "blocked",
      reason: "outside_border",
      kmBeyondBorder,
      nearestRoadMeters,
      graphChecked,
      message: "This store is outside Tacurong City. SUGO Express currently operates exclusively within Tacurong City.",
    };
  } else if (graphChecked && nearestRoadMeters! > OFF_GRAPH_METERS) {
    verdict = {
      status: "blocked",
      reason: "off_road_map",
      kmBeyondBorder,
      nearestRoadMeters,
      graphChecked,
      message: "This spot is not near any road on the map, so no rider route can be planned there. Check the pin.",
    };
  } else if (
    STORE_PIN_MAX_KM_BEYOND_BORDER !== null &&
    kmBeyondBorder > STORE_PIN_MAX_KM_BEYOND_BORDER
  ) {
    verdict = {
      status: "blocked",
      reason: "beyond_cap",
      kmBeyondBorder,
      nearestRoadMeters,
      graphChecked,
      message: `This store is ${km(kmBeyondBorder)} km past the Tacurong border. Stores more than ${km(STORE_PIN_MAX_KM_BEYOND_BORDER)} km outside cannot be pinned.`,
    };
  } else {
    verdict = {
      status: "inside",
      reason: "inside_border",
      kmBeyondBorder: 0,
      nearestRoadMeters,
      graphChecked,
      message: "Inside Tacurong.",
    };
  }

  // Only cache an answer the graph actually took part in. A fail-open verdict
  // from an OSRM blip must not stick for ten minutes after it recovers.
  if (graphChecked) cache.set(key, { at: Date.now(), verdict });
  return verdict;
}

/** For tests and after a graph swap. */
export function clearStoreLocationCache(): void {
  cache.clear();
}
