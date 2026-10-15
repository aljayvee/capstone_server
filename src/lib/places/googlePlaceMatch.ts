import { haversineDistanceKm, type GeoPoint } from "../geo.js";
import { searchPlacesByText, type GooglePlace } from "./googlePlacesClient.js";
import { namesLookRelated } from "./placeDuplicates.js";
import { normalizeStoreName } from "../../services/storePredictionService.js";

/**
 * The Google Maps place a Location Store with no link most likely is
 * (2026-10-13): Google's answer for its name with a related name (the same,
 * or one starting with the other) within MATCH_METERS of its pin, or the only
 * related answer in the city. Used by the one-time link script and when a
 * retired unlinked store is restored.
 */
export const MATCH_METERS = 400;

export type GoogleMatch =
  | { status: "matched"; place: GooglePlace; metres: number }
  /** A match, but another Location Store already is that Google Maps place. */
  | { status: "taken"; place: GooglePlace; metres: number }
  | { status: "none"; related: number }
  | { status: "unavailable" };

export async function matchGooglePlace(
  name: string,
  pin: GeoPoint,
  isTaken: (googlePlaceId: string) => boolean
): Promise<GoogleMatch> {
  const found = await searchPlacesByText(name);
  if (found === null) return { status: "unavailable" };
  const key = normalizeStoreName(name);
  const candidates = found
    .filter((place) => namesLookRelated(key, normalizeStoreName(place.name)))
    .map((place) => ({ place, metres: Math.round(haversineDistanceKm(pin, place) * 1000) }))
    .sort((a, b) => a.metres - b.metres);
  const best = candidates[0];
  if (!best || (best.metres > MATCH_METERS && candidates.length > 1)) return { status: "none", related: candidates.length };
  return { status: isTaken(best.place.googlePlaceId) ? "taken" : "matched", ...best };
}
