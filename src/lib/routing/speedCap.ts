import { ROUTE_MAX_SPEED_KMH } from "../../config/env.js";

/**
 * A travel time no faster than a rider can actually go.
 *
 * Applied per route step, not per trip: a step is one stretch of one road, so
 * only the stretches the engine assumed were fast get slower. Town streets,
 * already estimated at 25 to 45 km/h, are left exactly as OSRM priced them.
 *
 * Never shortens a duration, and returns the original untouched when the cap is
 * off (0) or there is no distance to measure against.
 */
export function cappedDurationSeconds(
  distanceMeters: number,
  durationSeconds: number,
  maxSpeedKmh: number = ROUTE_MAX_SPEED_KMH
): number {
  if (!(maxSpeedKmh > 0) || !(distanceMeters > 0)) return durationSeconds;
  return Math.max(durationSeconds, distanceMeters / (maxSpeedKmh / 3.6));
}
