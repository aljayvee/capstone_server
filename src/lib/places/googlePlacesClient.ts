import { GOOGLE_PLACES_API_KEY } from "../../config/env.js";
import { logger } from "../logger.js";
import type { GeoPoint } from "../geo.js";
import { isWithinServiceBuffer, serviceAreaEnvelope } from "../serviceArea.js";

/**
 * Google Places API (New), for the customer app's "Location" store picker.
 *
 * Until 2026-10-08 Places ran only in the dispatcher's browser (Maps JS in
 * useStorePins.ts). The customer picks stores too now, and their phone must not
 * carry a Places-enabled key, so the server asks on its behalf.
 *
 * Nothing here is cached. Google's terms allow keeping place ids only, and every
 * search is a fresh, billed request, which is why the route has its own limiter.
 * Every failure (no key, the API not enabled for the key, a timeout) answers
 * null, and the caller falls back to the owner's Location Stores.
 */

const BASE_URL = "https://places.googleapis.com/v1/places";
const REQUEST_TIMEOUT_MS = 4000;
/**
 * Google's page maximum. These are candidates for the ranking
 * (lib/places/storeRanking.ts), which shows 4 nearby or 10 for a search; the
 * price is per request, not per result.
 */
const RESULT_LIMIT = 20;
/** How far a "near me" list reaches. Tacurong's shops sit well inside it. */
const NEARBY_RADIUS_METERS = 3000;
/** How far the Home tab's "Popular Stores" reaches: the city, not just the block. */
const POPULAR_RADIUS_METERS = 5000;

// The pabili kinds of shop. Every entry must be one of Google's Table A types:
// one unknown type fails the whole request with INVALID_ARGUMENT.
const PABILI_TYPES = [
  "restaurant",
  "fast_food_restaurant",
  "meal_takeaway",
  "cafe",
  "bakery",
  "pharmacy",
  "drugstore",
  "supermarket",
  "grocery_store",
  "convenience_store",
  "department_store",
  "hardware_store",
  "shopping_mall",
  "store",
];

/**
 * The pabili kinds of shop one at a time, for "Popular Stores", which wants the
 * best of each merchant category (establishmentCategory.ts files each kind
 * under a category). Every entry is also in PABILI_TYPES, so it is a vetted
 * Table A type: one unknown type fails a whole request.
 */
export const KIND_SEARCH_TYPES: Record<string, string[]> = {
  bakery: ["bakery"],
  fastfood: ["fast_food_restaurant", "meal_takeaway"],
  restaurant: ["restaurant", "cafe"],
  pharmacy: ["pharmacy", "drugstore"],
  grocery: ["supermarket", "grocery_store"],
  convenience: ["convenience_store"],
  retail: ["department_store", "hardware_store", "shopping_mall"],
};

/**
 * "Popular Stores" asks twice: once for food and once for everything else. One
 * search over every type came back all cafes and restaurants, which collect
 * most of Tacurong's Google reviews; split, the shops get a list of their own.
 */
export const POPULAR_FOOD_TYPES = [...KIND_SEARCH_TYPES.bakery, ...KIND_SEARCH_TYPES.fastfood, ...KIND_SEARCH_TYPES.restaurant];
export const POPULAR_SHOP_TYPES = [
  ...KIND_SEARCH_TYPES.pharmacy,
  ...KIND_SEARCH_TYPES.grocery,
  ...KIND_SEARCH_TYPES.convenience,
  ...KIND_SEARCH_TYPES.retail,
];

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.shortFormattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  // Same price tier as the fields above: a shop's own photo for the Home tab's
  // cards. Its image address is looked up only when the Home row asks for photos
  // (lib/places/placePhotos.ts).
  "places.photos",
].join(",");

/**
 * Ratings cost a higher price tier on every request that asks for them, so only
 * the popular search does; the nearby list and typed searches never pay it.
 */
const POPULAR_FIELD_MASK = `${FIELD_MASK},places.rating,places.userRatingCount`;

export interface GooglePlace {
  googlePlaceId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  types: string[];
  primaryType: string | null;
  /**
   * The shop's first photo: its resource name ("places/<id>/photos/<ref>") and
   * who took it. Google requires the author shown wherever the photo is.
   */
  photo: { name: string; attribution: string | null } | null;
  /** Google's star rating, 1 to 5. Null unless the search asked for ratings, or nobody has rated it. */
  rating: number | null;
  /** How many people rated it. Null under the same conditions. */
  ratingCount: number | null;
}

export function isGooglePlacesConfigured(): boolean {
  return Boolean(GOOGLE_PLACES_API_KEY);
}

/** Shops nearest to `centre`, closest first. Null when Google cannot answer. */
export function searchNearbyPlaces(centre: GeoPoint): Promise<GooglePlace[] | null> {
  return post("searchNearby", {
    includedTypes: PABILI_TYPES,
    maxResultCount: RESULT_LIMIT,
    rankPreference: "DISTANCE",
    locationRestriction: {
      circle: { center: centre, radius: NEARBY_RADIUS_METERS },
    },
    languageCode: "en",
    regionCode: "ph",
  });
}

/** Shops matching `query` inside the service area. Null when Google cannot answer. */
/**
 * The shops of `includedTypes` Google considers most popular around `centre`,
 * with their ratings. The Home tab's "Popular Stores" picks the best rated of
 * each merchant category from them (establishmentService.popularEstablishments).
 * Null when Google cannot answer.
 */
export function searchPopularPlaces(centre: GeoPoint, includedTypes: string[] = PABILI_TYPES): Promise<GooglePlace[] | null> {
  return post(
    "searchNearby",
    {
      includedTypes,
      maxResultCount: RESULT_LIMIT,
      rankPreference: "POPULARITY",
      locationRestriction: {
        circle: { center: centre, radius: POPULAR_RADIUS_METERS },
      },
      languageCode: "en",
      regionCode: "ph",
    },
    POPULAR_FIELD_MASK
  );
}

export function searchPlacesByText(query: string): Promise<GooglePlace[] | null> {
  const box = serviceAreaEnvelope();
  return post("searchText", {
    textQuery: query,
    pageSize: RESULT_LIMIT,
    // A hard boundary, not a bias: without it "Mercury Drug" answers with
    // branches across Mindanao before the ones a rider can reach.
    ...(box
      ? {
          locationRestriction: {
            rectangle: {
              low: { latitude: box.minLat, longitude: box.minLng },
              high: { latitude: box.maxLat, longitude: box.maxLng },
            },
          },
        }
      : {}),
    languageCode: "en",
    regionCode: "ph",
  });
}

// One warning per kind of failure, not one per keystroke.
const warned = new Set<string>();

function warnOnce(kind: string, message: string) {
  if (warned.has(kind)) return;
  warned.add(kind);
  logger.warn(message);
}

async function post(
  method: "searchNearby" | "searchText",
  body: unknown,
  fieldMask: string = FIELD_MASK
): Promise<GooglePlace[] | null> {
  if (!isGooglePlacesConfigured()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}:${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data: any = await response.json().catch(() => null);
    if (!response.ok) {
      // SERVICE_DISABLED / PERMISSION_DENIED: the key's project has not enabled
      // Places API (New). A setting in Google Cloud, not a code fault.
      const status = data?.error?.status ?? `HTTP ${response.status}`;
      warnOnce(status, `Google Places ${method} refused (${status}): ${data?.error?.message ?? "no detail"}`);
      return null;
    }
    warned.clear();
    return toPlaces(data?.places);
  } catch (error) {
    warnOnce("network", `Google Places ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function firstPhoto(photos: unknown): GooglePlace["photo"] {
  const photo: any = Array.isArray(photos) ? photos[0] : null;
  if (!photo?.name) return null;
  const author = photo.authorAttributions?.[0]?.displayName;
  return { name: String(photo.name), attribution: author ? String(author) : null };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return value === undefined || value === null || !Number.isFinite(n) ? null : n;
}

/** Open shops with a name and a position inside the service area. */
export function toPlaces(raw: unknown): GooglePlace[] {
  if (!Array.isArray(raw)) return [];
  const places: GooglePlace[] = [];
  for (const place of raw) {
    const name = String(place?.displayName?.text ?? "").trim();
    const latitude = Number(place?.location?.latitude);
    const longitude = Number(place?.location?.longitude);
    if (!place?.id || !name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (place.businessStatus === "CLOSED_PERMANENTLY") continue;
    if (!isWithinServiceBuffer({ latitude, longitude }, 0.1)) continue;
    places.push({
      googlePlaceId: String(place.id),
      name,
      address: String(place.shortFormattedAddress ?? "").trim(),
      latitude,
      longitude,
      types: Array.isArray(place.types) ? place.types.map(String) : [],
      primaryType: place.primaryType ? String(place.primaryType) : null,
      photo: firstPhoto(place.photos),
      rating: numberOrNull(place.rating),
      ratingCount: numberOrNull(place.userRatingCount),
    });
  }
  return places;
}
