import type { MapProvider } from "./bestRoute.js";

/**
 * Which map a rider is shown today: OpenStreetMap ("osrm") or Google.
 *
 * Without this the map was whichever engine won the rider's first route after
 * opening the app, so the split between the two maps followed the ETA race and
 * nobody knew what it was. The PATH is still the fastest of the two engines'
 * (bestRoute.ts); only the map it is drawn on is assigned, and bestRoute
 * redraws the winning path on that map's roads.
 *
 * By rider and Manila day:
 *  - one rider gets one map all day, however often the app is reopened, and
 *    the other map the next day, so every rider's days split evenly;
 *  - the rider's half comes from a hash of the id, not the id itself, so riders
 *    whose ids share a parity do not all land on the same map the same day.
 *
 * Assigned only when the app has not shown a map yet. Once it has, the app
 * names it on every request and keeps it for the session (the Huawei Petal
 * contract, RiderMobileApp config/mapChoice.ts).
 */

/** Manila is UTC+8 all year; the Philippines has no daylight saving time. */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Days since 1970-01-01 on the Manila calendar. */
export function manilaDayNumber(now: number = Date.now()): number {
  return Math.floor((now + MANILA_OFFSET_MS) / DAY_MS);
}

/** The Manila calendar day as midnight UTC of that date, for a DATE column. */
export function manilaDay(now: number = Date.now()): Date {
  return new Date(manilaDayNumber(now) * DAY_MS);
}

// MurmurHash3's 32-bit finaliser: neighbouring ids come out unrelated.
function mix(id: number): number {
  let h = id | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function assignedMapFor(riderId: number, now: number = Date.now()): MapProvider {
  const half = mix(riderId) & 1;
  return (half ^ (manilaDayNumber(now) & 1)) === 0 ? "osrm" : "google";
}
