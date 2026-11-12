import { GOOGLE_PLACES_API_KEY } from "../../config/env.js";
import { logger } from "../logger.js";
import type { GeoPoint } from "../geo.js";
import { isWithinServiceBuffer, serviceAreaEnvelope, type ServiceZone } from "../serviceArea.js";
import { hasPlacesAllowance, spendPlacesRequest, type PlacesSku } from "./placesBudget.js";

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
 *
 * Every request is counted against Google's free monthly allowance first
 * (placesBudget.ts), and one past it is not sent: it answers null like any
 * other failure. Since 2026-10-13 only the popular search asks for opening
 * hours and ratings, the dear "Enterprise" tier (1,000 free a month); the
 * nearby, category and typed searches ask the "Pro" tier (5,000 free).
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
/** How far a merchant category's store list reaches (2026-10-10): one kind of shop is sparser, so the city. */
export const CATEGORY_RADIUS_METERS = 5000;

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

/**
 * Every type a merchant category's store list may search for, one by one: a
 * category's list asks for the types that file under it (establishmentService
 * googleTypesFor, by establishmentCategory's claims and kinds), so a category
 * the owner adds ("Pet Supplies", "Hardware") finds its shops by type with no
 * code change. Each is a Table A type, all accepted together by a live
 * searchNearby on 2026-10-10: one unknown type fails a whole request.
 */
export const SEARCHABLE_TYPES = [
  ...PABILI_TYPES.filter((type) => type !== "store"),
  "coffee_shop",
  "tea_house",
  "juice_shop",
  "ice_cream_shop",
  "dessert_shop",
  "donut_shop",
  "sandwich_shop",
  "pizza_restaurant",
  "hamburger_restaurant",
  "butcher_shop",
  "food_store",
  // Not "market": Google files flower and vape shops under it, and searching it
  // filled Supermarket & Grocery with them (classifying by it is fine).
  "wholesaler",
  "discount_store",
  "liquor_store",
  "pet_store",
  "book_store",
  "clothing_store",
  "shoe_store",
  "jewelry_store",
  "electronics_store",
  "cell_phone_store",
  "furniture_store",
  "home_goods_store",
  "home_improvement_store",
  "bicycle_store",
  "sporting_goods_store",
  "gift_shop",
  "florist",
];
export const POPULAR_SHOP_TYPES = [
  ...KIND_SEARCH_TYPES.pharmacy,
  ...KIND_SEARCH_TYPES.grocery,
  ...KIND_SEARCH_TYPES.convenience,
  ...KIND_SEARCH_TYPES.retail,
];

/**
 * Types from Google Places that describe non-Pabili destinations
 * (Schools, Banks, Padala/Remittance centers, Motor trade/repair shops).
 * Any Google place whose primary type or only matching types fall here
 * is pruned from the Customer App store search.
 */
export const NON_PABILI_GOOGLE_TYPES = new Set([
  // Schools & Education
  "school",
  "primary_school",
  "secondary_school",
  "university",
  "preschool",
  "library",

  // Banks, Financial & Professional Offices
  "bank",
  "atm",
  "finance",
  "accounting",
  "insurance_agency",
  "real_estate_agency",
  "travel_agency",
  "lawyer",
  "legal_services",

  // Padala & Remittance
  "money_transfer",

  // Motor Trades, Repairs & Gas/Fuel Stations
  "auto_repair",
  "car_repair",
  "motorcycle_repair",
  "car_dealer",
  "motorcycle_dealer",
  "auto_parts_store",
  "car_rental",
  "gas_station",
  "electric_vehicle_charging_station",
  "truck_stop",

  // Police Outposts, Emergency & Transit Stations
  "police",
  "fire_station",
  "emergency_service",
  "transit_station",
  "bus_station",
  "train_station",
  "light_rail_station",
  "subway_station",
  "taxi_stand",
  "ferry_terminal",
  "airport",
  "heliport",

  // Government Offices & Public Administration
  "government_office",
  "local_government_office",
  "city_hall",
  "courthouse",
  "embassy",
  "post_office",
  "tax_preparation",
  "community_center",

  // Network, Telecom, ISP & Corporate Offices
  "telecommunications_service_provider",
  "internet_service_provider",
  "corporate_office",
  "consultant",
  "marketing_agency",

  // Internet Cafe
  "internet_cafe",

  // Nightclubs, Bars & Adult Entertainment
  "night_club",
  "bar",
  "pub",
  "wine_bar",
  "karaoke",
  "comedy_club",
  "casino",
  "adult_entertainment_club",

  // Logistics, Courier, Freight & Storage
  "courier_service",
  "shipping_service",
  "moving_company",
  "storage",

  // Salons & Personal Care
  "beauty_salon",
  "hair_salon",
  "barber_shop",
  "nail_salon",
  "spa",
  "laundry",

  // Carwash & Detailing
  "car_wash",

  // Lodging, Worship, Funeral & Fitness
  "lodging",
  "hotel",
  "motel",
  "resort_hotel",
  "hostel",
  "guest_house",
  "church",
  "place_of_worship",
  "mosque",
  "synagogue",
  "hindu_temple",
  "funeral_home",
  "cemetery",
  "gym",
  "fitness_center",
]);


/**
 * Google's "Pro" tier (5,000 free requests a month): everything a store row
 * needs except opening hours and ratings. Opening hours were asked for here
 * until 2026-10-13, which put every search on the Enterprise tier (1,000 free)
 * and cost USD 23.88 in twelve days. Without them a store's open or closed
 * state comes from its kind of shop and past orders
 * (establishmentService.evaluateStoreOperatingStatus).
 */
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
 * Ratings and opening hours cost the Enterprise tier on every request that asks
 * for them, so only the popular search does, and only while that tier's free
 * allowance lasts. `nextCloseTime` lets a kept answer change from open to
 * closed on time (googleOpenNowAt).
 */
const POPULAR_FIELD_MASK = [
  FIELD_MASK,
  "places.currentOpeningHours.openNow",
  "places.currentOpeningHours.nextOpenTime",
  "places.currentOpeningHours.nextCloseTime",
  "places.regularOpeningHours.openNow",
  "places.regularOpeningHours.nextOpenTime",
  "places.regularOpeningHours.nextCloseTime",
  "places.rating",
  "places.userRatingCount",
].join(",");

export interface GooglePlace {
  googlePlaceId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  types: string[];
  primaryType: string | null;
  /**
   * True unless Google explicitly reports the establishment as closed right now
   * (`currentOpeningHours.openNow === false`, `regularOpeningHours.openNow === false`,
   * or `businessStatus === "CLOSED_TEMPORARILY"`).
   */
  isOpen: boolean;
  /**
   * Explicit Google Maps opening-hours status (`true` = open right now on Google Maps,
   * `false` = closed right now on Google Maps, `null` = no timetable set on Google Maps).
   */
  openNow?: boolean | null;
  /** ISO 8601 timestamp from Google Maps indicating when a closed place next opens, if available. */
  nextOpenTime?: string | null;
  /** ISO 8601 timestamp from Google Maps indicating when an open place next closes, if available. */
  nextCloseTime?: string | null;
  /** True when Google reports `businessStatus === "CLOSED_TEMPORARILY"`. */
  temporarilyClosed?: boolean;
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

/**
 * Shops nearest to `centre`, closest first. Null when Google cannot answer.
 * A merchant category's list narrows `includedTypes` to its kinds of shop
 * (KIND_SEARCH_TYPES) and reaches CATEGORY_RADIUS_METERS.
 */
export function searchNearbyPlaces(
  centre: GeoPoint,
  includedTypes: string[] = PABILI_TYPES,
  radiusMeters: number = NEARBY_RADIUS_METERS
): Promise<GooglePlace[] | null> {
  return post("searchNearby", {
    includedTypes,
    maxResultCount: RESULT_LIMIT,
    rankPreference: "DISTANCE",
    locationRestriction: {
      circle: { center: centre, radius: radiusMeters },
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
 *
 * Without ratings (`ratings: false`, or the Enterprise tier's free allowance
 * used up) it costs the Pro tier and every rating is null: the shops still come
 * in Google's own popularity order.
 */
export function searchPopularPlaces(
  centre: GeoPoint,
  includedTypes: string[] = PABILI_TYPES,
  options?: { ratings?: boolean }
): Promise<GooglePlace[] | null> {
  const ratings = (options?.ratings ?? true) && hasPlacesAllowance("nearbyEnterprise");
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
    ratings ? POPULAR_FIELD_MASK : FIELD_MASK
  );
}

export function searchPlacesByText(
  query: string,
  options?: {
    includeRatings?: boolean;
    /**
     * The zone to search, when the searcher's is known (2026-11-09). Without
     * it the box spans every zone, which with Banga added also covers
     * Koronadal, whose branches can crowd a 20-result page.
     */
    zone?: ServiceZone | null;
  }
): Promise<GooglePlace[] | null> {
  const box = serviceAreaEnvelope(options?.zone ?? undefined);
  return post(
    "searchText",
    {
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
    },
    options?.includeRatings && hasPlacesAllowance("textEnterprise") ? POPULAR_FIELD_MASK : FIELD_MASK
  );
}

/** A Google place id as Google writes them. Checked strictly: it goes into a Google URL. */
export const GOOGLE_PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

/** One Google Maps place, as the owner's Location Stores form needs it. */
export interface GooglePlaceDetails {
  googlePlaceId: string;
  name: string;
  /** Google's full address, e.g. "Alunan Hwy, Poblacion, City of Tacurong, 9800 Sultan Kudarat". */
  address: string;
  /** The barangay, from the address parts (Google's sublocality or neighbourhood). Null when not given. */
  barangay: string | null;
  latitude: number;
  longitude: number;
  types: string[];
  primaryType: string | null;
  /** "OPERATIONAL", "CLOSED_TEMPORARILY" or "CLOSED_PERMANENTLY", when Google says. */
  businessStatus: string | null;
  /** Google's `regularOpeningHours.periods`, only when asked for (`hours: true`). */
  openingPeriods: unknown[] | null;
}

export type PlaceDetailsAnswer =
  | { status: "ok"; place: GooglePlaceDetails }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * One place by its Google id (2026-10-13): the owner portal confirms every
 * Location Store is a real Google Maps place, and prefills the form from it.
 * Pro tier (5,000 free a month); with `hours`, Enterprise (1,000 free), and
 * without the hours when that allowance is used up.
 */
export async function getPlaceDetails(googlePlaceId: string, options?: { hours?: boolean }): Promise<PlaceDetailsAnswer> {
  if (!GOOGLE_PLACE_ID.test(googlePlaceId)) return { status: "not_found" };
  if (!isGooglePlacesConfigured()) return { status: "unavailable" };
  const hours = Boolean(options?.hours) && hasPlacesAllowance("detailsEnterprise");
  if (!spendPlacesRequest(hours ? "detailsEnterprise" : "detailsPro")) return { status: "unavailable" };

  const fields = [
    "id",
    "displayName",
    "formattedAddress",
    "addressComponents",
    "location",
    "types",
    "primaryType",
    "businessStatus",
    ...(hours ? ["regularOpeningHours"] : []),
  ].join(",");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/${googlePlaceId}?languageCode=en&regionCode=ph`, {
      headers: { "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY, "X-Goog-FieldMask": fields },
      signal: controller.signal,
    });
    const data: any = await response.json().catch(() => null);
    if (response.status === 404 || data?.error?.status === "NOT_FOUND" || data?.error?.status === "INVALID_ARGUMENT") {
      return { status: "not_found" };
    }
    if (!response.ok) {
      const status = data?.error?.status ?? `HTTP ${response.status}`;
      warnOnce(status, `Google Places details refused (${status}): ${data?.error?.message ?? "no detail"}`);
      return { status: "unavailable" };
    }
    const name = String(data?.displayName?.text ?? "").trim();
    const latitude = Number(data?.location?.latitude);
    const longitude = Number(data?.location?.longitude);
    if (!data?.id || !name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return { status: "not_found" };
    return {
      status: "ok",
      place: {
        googlePlaceId: String(data.id),
        name,
        address: String(data.formattedAddress ?? "").trim(),
        barangay: barangayOf(data.addressComponents),
        latitude,
        longitude,
        types: Array.isArray(data.types) ? data.types.map(String) : [],
        primaryType: data.primaryType ? String(data.primaryType) : null,
        businessStatus: data.businessStatus ? String(data.businessStatus) : null,
        openingPeriods: hours && Array.isArray(data.regularOpeningHours?.periods) ? data.regularOpeningHours.periods : null,
      },
    };
  } catch (error) {
    warnOnce("network", `Google Places details failed: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** The barangay in Google's address parts: the sublocality, else the neighbourhood. */
function barangayOf(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  for (const type of ["sublocality_level_1", "sublocality", "neighborhood"]) {
    const part = components.find((c: any) => Array.isArray(c?.types) && c.types.includes(type));
    const text = String(part?.longText ?? part?.shortText ?? "").trim();
    if (text) return text.replace(/^(brgy\.?|barangay)\s+/i, "");
  }
  return null;
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
  const tier = fieldMask === FIELD_MASK ? "Pro" : "Enterprise";
  const sku: PlacesSku = `${method === "searchNearby" ? "nearby" : "text"}${tier}`;
  // Past the free allowance: answer as if Google were down, never as a paid request.
  if (!spendPlacesRequest(sku)) return null;

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

/**
 * Minimum landscape aspect ratio (width / height) for a Google Maps photo.
 * Rejects vertical phone selfies (9:16, 3:4, 4:5) and square (1:1) profile portraits,
 * requiring at least a landscape frame (e.g. 4:3 = 1.33, 3:2 = 1.5, 16:9 = 1.77).
 */
const MIN_LANDSCAPE_ASPECT_RATIO = 1.15;
const MIN_PHOTO_WIDTH_PX = 400;
const MIN_PHOTO_HEIGHT_PX = 250;

function isLandscapeStorefrontPhoto(photo: any): boolean {
  if (!photo?.name) return false;
  const width = numberOrNull(photo.widthPx);
  const height = numberOrNull(photo.heightPx);
  // If Google supplied pixel dimensions, strictly reject vertical/portrait,
  // square (1:1), or tiny low-res thumbnail uploads.
  if (width !== null && height !== null) {
    if (width < MIN_PHOTO_WIDTH_PX || height < MIN_PHOTO_HEIGHT_PX) return false;
    if (width / height < MIN_LANDSCAPE_ASPECT_RATIO) return false;
  }
  return true;
}

function firstPhoto(photos: unknown): GooglePlace["photo"] {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  // Prefer a landscape storefront photo; fall back to Google's primary photo (photos[0])
  // so establishments with square or portrait photos still display their storefront.
  const bestLandscape = photos.find(isLandscapeStorefrontPhoto);
  const photo: any = bestLandscape ?? photos[0];
  if (!photo?.name) return null;
  const author = photo.authorAttributions?.[0]?.displayName;
  return { name: String(photo.name), attribution: author ? String(author) : null };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return value === undefined || value === null || !Number.isFinite(n) ? null : n;
}

function resolveGoogleOpenNow(place: any): boolean | null {
  if (typeof place?.currentOpeningHours?.openNow === "boolean") {
    return place.currentOpeningHours.openNow;
  }
  if (typeof place?.regularOpeningHours?.openNow === "boolean") {
    return place.regularOpeningHours.openNow;
  }
  return null;
}

function resolveGoogleNextOpenTime(place: any): string | null {
  const raw =
    place?.currentOpeningHours?.nextOpenTime ??
    place?.regularOpeningHours?.nextOpenTime ??
    null;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function resolveGoogleNextCloseTime(place: any): string | null {
  const raw =
    place?.currentOpeningHours?.nextCloseTime ??
    place?.regularOpeningHours?.nextCloseTime ??
    null;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Google's open-now as of `now`, for an answer kept a while (the popular list
 * keeps its search an hour): an open shop past the closing time Google gave is
 * closed, and a closed one past its opening time is open. Undefined or null
 * (no timetable) as Google gave it.
 */
export function googleOpenNowAt(
  place: Pick<GooglePlace, "openNow" | "nextOpenTime" | "nextCloseTime">,
  now: Date
): boolean | null | undefined {
  const passed = (iso: string | null | undefined) => {
    const at = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(at) && now.getTime() >= at;
  };
  if (place.openNow === true && passed(place.nextCloseTime)) return false;
  if (place.openNow === false && passed(place.nextOpenTime)) return true;
  return place.openNow;
}

function isPlaceOpen(place: any): boolean {
  if (place?.businessStatus === "CLOSED_TEMPORARILY") return false;
  const openNow = resolveGoogleOpenNow(place);
  return openNow !== false;
}

const STREET_ROAD_TOKENS = new Set([
  "street",
  "st",
  "road",
  "rd",
  "highway",
  "hwy",
  "avenue",
  "ave",
  "boulevard",
  "blvd",
  "lane",
  "ln",
  "drive",
  "dr",
  "way",
  "expressway",
  "rotary",
  "junction",
  "crossing",
]);

const KNOWN_BUSINESS_TOKENS = new Set([
  "pharmacy",
  "drug",
  "bakery",
  "bakeshop",
  "restaurant",
  "resto",
  "grill",
  "cafe",
  "coffee",
  "diner",
  "eatery",
  "store",
  "shop",
  "mart",
  "grocery",
  "supermarket",
  "hardware",
  "meat",
  "chicken",
  "pizza",
  "burger",
  "tea",
  "buko",
  "pie",
  "pasalubong",
  "salon",
  "barber",
  "pet",
  "petshop",
  "boutique",
  "clothing",
  "apparel",
  "kitchen",
  "food",
  "kitchenette",
  "fastfood",
  "deli",
  "icecream",
  "donut",
  "lechon",
  "bbq",
  "balbakwa",
  "kambingan",
  "lutong",
  "haus",
  "house",
  "shack",
  "center",
  "hub",
  "plaza",
  "mall",
  "bazaar",
  "trading",
  "enterprise",
  "supply",
  "supplies",
  "depot",
  "wholesaler",
  "retail",
  "gadgets",
  "computers",
  "tailor",
  "florist",
  "botica",
  "farmacia",
  "refreshment",
  "canteen",
  "carinderia",
  // Common national & regional retail / food brands
  "jollibee",
  "mcdonald",
  "mcdonalds",
  "mcdo",
  "chowking",
  "greenwich",
  "manginasal",
  "kfc",
  "dunkin",
  "mercury",
  "watsons",
  "rose",
  "generics",
  "southstar",
  "fitmart",
  "kcc",
  "gaisano",
  "savemore",
  "puregold",
  "alfamart",
  "ministop",
]);

const MUNICIPALITY_STRIP_WORDS = new Set([
  "tacurong",
  "city",
  "of",
  "sultan",
  "kudarat",
  "banga",
  "south",
  "cotabato",
  "poblacion",
  "philippines",
]);

/**
 * Returns true if the place's name is purely a road or highway identifier
 * (e.g. "Ledesma street", "Lesdema street tacurong city", "National Highway", "Tacurong - Isulan Rd")
 * without any business or merchant brand keyword.
 */
export function isStreetOnlyName(name: string): boolean {
  const norm = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return false;

  const rawWords = norm.split(" ").filter(Boolean);
  const words = rawWords.filter((w) => !MUNICIPALITY_STRIP_WORDS.has(w));
  if (words.length === 0) return true;

  const hasStreetToken = words.some((w) => STREET_ROAD_TOKENS.has(w));
  if (!hasStreetToken) return false;

  const hasBusinessKeyword = words.some((w) => KNOWN_BUSINESS_TOKENS.has(w));
  if (hasBusinessKeyword) return false;

  return words.length <= 3;
}

const PLUS_CODE_REGEX = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}/;

/**
 * Returns true if an address is purely a Plus Code or city-level string without a specific street/building,
 * and the establishment has zero customer photos and zero ratings.
 */
export function isVagueOrUnverifiedAddress(
  address: string,
  hasPhoto: boolean,
  rating: number | null,
  ratingCount: number | null
): boolean {
  if (hasPhoto || (rating !== null && (ratingCount ?? 0) > 0)) {
    return false;
  }

  const trimmed = address.trim();
  if (!trimmed) return true;

  const withoutCode = trimmed.replace(PLUS_CODE_REGEX, "").replace(/^[\s,]+/, "").trim();
  if (!withoutCode) return true;

  const lower = withoutCode.toLowerCase();
  if (
    lower === "city of tacurong" ||
    lower === "tacurong city" ||
    lower === "tacurong" ||
    lower === "tacurong, sultan kudarat" ||
    lower === "tacurong city, sultan kudarat" ||
    lower === "banga" ||
    lower === "municipality of banga" ||
    lower === "banga, south cotabato"
  ) {
    return true;
  }

  return false;
}

/**
 * Drops ambiguous road-centroid coordinate collisions: when multiple places
 * share the exact same latitude and longitude (~11m grid), keeps the one with
 * genuine storefront signals (photos/ratings/real address) and drops unverified clones.
 */
export function deduplicateCoordinateCollisions(places: GooglePlace[]): GooglePlace[] {
  if (places.length <= 1) return places;

  const groups = new Map<string, GooglePlace[]>();
  for (const place of places) {
    const key = `${place.latitude.toFixed(4)},${place.longitude.toFixed(4)}`;
    const group = groups.get(key) ?? [];
    group.push(place);
    groups.set(key, group);
  }

  const result: GooglePlace[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    const sorted = [...group].sort((a, b) => {
      const aScore = (a.photo ? 10 : 0) + (a.ratingCount ?? 0) + (a.rating ? 2 : 0);
      const bScore = (b.photo ? 10 : 0) + (b.ratingCount ?? 0) + (b.rating ? 2 : 0);
      return bScore - aScore;
    });

    result.push(sorted[0]);
  }

  return result;
}

/** Shops with a name and a position inside the service area (permanently closed excluded). */
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

    // Reject ghost places whose name is purely a street, avenue, or highway
    if (isStreetOnlyName(name)) continue;

    const temporarilyClosed = place.businessStatus === "CLOSED_TEMPORARILY";
    const openNow = temporarilyClosed ? false : resolveGoogleOpenNow(place);
    const nextOpenTime = temporarilyClosed ? null : resolveGoogleNextOpenTime(place);
    const nextCloseTime = temporarilyClosed ? null : resolveGoogleNextCloseTime(place);
    places.push({
      googlePlaceId: String(place.id),
      name,
      address: String(place.shortFormattedAddress ?? "").trim(),
      latitude,
      longitude,
      types: Array.isArray(place.types) ? place.types.map(String) : [],
      primaryType: place.primaryType ? String(place.primaryType) : null,
      isOpen: isPlaceOpen(place),
      openNow,
      nextOpenTime,
      nextCloseTime,
      temporarilyClosed,
      photo: firstPhoto(place.photos),
      rating: numberOrNull(place.rating),
      ratingCount: numberOrNull(place.ratingCount ?? place.userRatingCount),
    });
  }
  return places;
}
