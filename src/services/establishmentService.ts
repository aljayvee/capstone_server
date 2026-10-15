import { haversineDistanceKm, type GeoPoint } from "../lib/geo.js";
import {
  isGooglePlacesConfigured,
  googleOpenNowAt,
  searchNearbyPlaces,
  searchPlacesByText,
  searchPopularPlaces,
  CATEGORY_RADIUS_METERS,
  SEARCHABLE_TYPES,
  POPULAR_FOOD_TYPES,
  POPULAR_SHOP_TYPES,
  NON_PABILI_GOOGLE_TYPES,
  isStreetOnlyName,
  type GooglePlace,
} from "../lib/places/googlePlacesClient.js";
import { isPabiliCategoryName } from "../lib/blockedCategoryNames.js";
import {
  categorizeGooglePlaces,
  categoryForGoogleTypes,
  wordsOf,
  type CategoryRef,
} from "../lib/places/establishmentCategory.js";
import { resolvePhotoUris } from "../lib/places/placePhotos.js";
import { isOpenByHours, nextOpeningNotice, parseWeeklyHours } from "../lib/places/storeHours.js";
import { placeRepository, type OwnerExtrasRow } from "../repositories/placeRepository.js";
import {
  nameMatchScore,
  PERSONAL_HALF_LIFE_DAYS,
  POPULARITY_HALF_LIFE_DAYS,
  bestRatedPerGroup,
  orderPopular,
  rankByRating,
  rankByRecommendation,
  recencyWeight,
  type PopularSort,
} from "../lib/places/storeRanking.js";
import { featuredFirst, parseFeaturedBrands } from "../lib/places/featuredBrands.js";
import { FEATURED_STORE_BRANDS } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { isWithinServiceBuffer, SERVICE_AREA_CENTRE } from "../lib/serviceArea.js";
import { merchantCategoryRepository } from "../repositories/merchantCategoryRepository.js";
import type { IVerifiedPlace } from "../types/place.js";
import { placeService } from "./placeService.js";
import { normalizeStoreName } from "./storePredictionService.js";

/**
 * The customer app's "Location" store picker: real establishments a customer
 * can name as the store to buy from, instead of a merchant category.
 *
 * Two sources. The owner's Location Stores (`verified_places`) are verified by
 * hand and carry their own category; Google Places covers every other shop in
 * the city, with a category worked out from its types (lib/places/
 * establishmentCategory.ts). Without a query the candidates are the shops
 * nearest the customer, from Google; with one, both sources are searched and
 * merged. Either way the rows shown are picked by lib/places/storeRanking.ts.
 */

/** Rows for a typed search. */
export const ESTABLISHMENT_LIMIT = 10;
/** Rows for the "near you" list shown before anything is typed (10 until 2026-10-08). */
export const NEARBY_LIMIT = 4;
/** The most the "Stores near you" screen pages through (2026-10-11): all one Google search gives. */
export const NEARBY_MAX = 20;
/** Stores considered before ranking picks the rows shown (lib/places/storeRanking.ts). */
export const CANDIDATE_LIMIT = 20;
/** Rows for a merchant category's list, opened from Home's category tiles (2026-10-10): all Google gives. */
export const CATEGORY_LIMIT = 20;
/** The Home tab's "Popular Stores": a page of 6 by default; Home's row shows 3 of them. */
export const POPULAR_LIMIT = 6;
/** The most the Popular Stores screen pages through (2026-10-10). */
export const POPULAR_MAX = 20;
/**
 * How long Google's popular answer is kept (2 minutes until 2026-10-13). It
 * costs the dearest tier and Tacurong's best-rated shops do not change by the
 * hour; opening times still turn on time (googlePlacesClient.googleOpenNowAt).
 */
const POPULAR_POOL_MAX_AGE_MS = 60 * 60 * 1000;
/** How long a nearby, category or typed search is kept: one search serves a half hour of customers. */
const SEARCH_POOL_MAX_AGE_MS = 30 * 60 * 1000;
/** A typed search shorter than this asks only the owner's Location Stores: two letters match half the city. */
export const GOOGLE_MIN_QUERY_LENGTH = 3;
const POPULAR_POOL_CACHE_MAX = 200;

/** Past orders older than this say nothing about a customer's habits now. */
export const HISTORY_WINDOW_DAYS = 365;
/** Popularity is about what people order lately. */
export const POPULARITY_WINDOW_DAYS = 90;
/** A ceiling on the pins read per search, newest first. */
const HISTORY_PIN_LIMIT = 5000;
const DAY_MS = 86_400_000;

/**
 * A Plus Code at the front of an address, as in "MMJ7+HC9, Tacurong City".
 * Google gives one where a shop has no street address, and it means nothing to
 * a customer. Four or more characters before the "+", so "22+ Mart" survives.
 */
const LEADING_PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(?=[\s,]|$)[\s,]*/;

export function withoutPlusCode(address: string): string {
  return address.replace(LEADING_PLUS_CODE, "").trim();
}

/** Two rows this close with one name are one shop (the dispatcher's SAME_PLACE_METERS). */
export const SAME_PLACE_METERS = 40;

export interface Establishment {
  /** Stable within a list: "catalogue:<uuid>" or "google:<place id>". */
  key: string;
  source: "catalogue" | "google";
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  /** True for owner-verified catalogue stores (from `verified_places`). */
  isVerified: boolean;
  /** The Location Stores row, for a catalogue pick. Google picks have none. */
  placeId: string | null;
  googlePlaceId: string | null;
  categoryId: number | null;
  categoryName: string | null;
  /** From the point the customer searched near, when they gave one. */
  distanceMeters: number | null;
  /** True unless Google explicitly reports the store as closed right now. */
  isOpen: boolean;
  /**
   * User-friendly notice when `isOpen === false` (e.g. "Opens at 8:00 AM" or "Temporarily Unavailable").
   * Null when `isOpen === true`.
   */
  closedReason?: string | null;
  /** The customer searching has ordered from this store before. */
  orderedBefore: boolean;
  /** Google's name for the shop's own photo (lib/places/placePhotos.ts). Null for Location Stores. */
  photoName: string | null;
  /** Who took that photo. Google requires it shown with the photo. */
  photoAttribution: string | null;
  /** The photo's image address, loadable with no key or sign-in. Only filled when the caller asks for photos. */
  photoUrl: string | null;
  /** Google's star rating. Only the popular list asks for it; null elsewhere and for Location Stores. */
  rating: number | null;
  /** How many people rated it. */
  ratingCount: number | null;
  /**
   * One of the brands "Find stores" recommends first (lib/places/featuredBrands.ts).
   * Only set on a list asked for with `featured`; absent everywhere else.
   */
  featured?: boolean;
}

export interface EstablishmentSearch {
  items: Establishment[];
  /** "unavailable": Google could not answer, and the list is Location Stores alone. */
  google: "ok" | "unavailable";
  /** The nearby list only: another page follows this one. */
  hasMore?: boolean;
  /** True when the customer's requested location is outside the Tacurong City service area. */
  outsideServiceArea?: boolean;
}

const metres = (a: GeoPoint, b: GeoPoint) => Math.round(haversineDistanceKm(a, b) * 1000);

export function fromCatalogue(place: IVerifiedPlace, near: GeoPoint | null): Establishment {
  return {
    key: `catalogue:${place.id}`,
    source: "catalogue",
    name: place.name,
    address: withoutPlusCode([place.address, place.barangay].filter(Boolean).join(", ")),
    latitude: place.latitude,
    longitude: place.longitude,
    isVerified: true,
    placeId: place.id,
    googlePlaceId: null,
    categoryId: place.category?.id ?? place.categoryId ?? null,
    categoryName: place.category?.name ?? null,
    distanceMeters: near ? metres(near, place) : null,
    isOpen: true,
    closedReason: null,
    orderedBefore: false,
    photoName: null,
    photoAttribution: null,
    photoUrl: null,
    rating: null,
    ratingCount: null,
  };
}

export function fromGoogle(place: GooglePlace, category: CategoryRef | null, near: GeoPoint | null): Establishment {
  const isOpen = place.isOpen !== false;
  return {
    key: `google:${place.googlePlaceId}`,
    source: "google",
    name: place.name,
    address: withoutPlusCode(place.address),
    latitude: place.latitude,
    longitude: place.longitude,
    isVerified: false,
    placeId: null,
    googlePlaceId: place.googlePlaceId,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    distanceMeters: near ? metres(near, place) : null,
    isOpen,
    closedReason: isOpen ? null : place.temporarilyClosed ? "Temporarily Unavailable" : null,
    orderedBefore: false,
    photoName: place.photo?.name ?? null,
    photoAttribution: place.photo?.attribution ?? null,
    photoUrl: null,
    rating: place.rating ?? null,
    ratingCount: place.ratingCount ?? null,
  };
}

/** One shop listed twice: the same name, give or take "Tacurong" and punctuation, within 40 m. */
export function isSamePlace(a: Establishment, b: Establishment): boolean {
  if (a.googlePlaceId && a.googlePlaceId === b.googlePlaceId) return true;
  if (a.placeId && a.placeId === b.placeId) return true;
  const name = normalizeStoreName(a.name);
  return name.length > 0 && name === normalizeStoreName(b.name) && metres(a, b) <= SAME_PLACE_METERS;
}

/**
 * One list from both sources, each shop once, at most `limit` rows.
 *
 * `catalogue` arrives ranked by placeService.searchPlaces, `google` in Google's
 * own order (relevance for a query, distance for "near me").
 */
export function mergeEstablishments(
  catalogue: Establishment[],
  google: Establishment[],
  limit: number = ESTABLISHMENT_LIMIT
): Establishment[] {
  // A shop both sources know is listed as the owner's row: it carries a verified
  // category and the placeId the pin keeps. When Google also found the same shop,
  // carry over Google's storefront photo and rating metadata so verified catalogue
  // stores don't lose their real storefront photo or star rating.
  const enrichedCatalogue = catalogue.map((c) => {
    const match = google.find((g) => isSamePlace(c, g));
    if (!match) return c;
    return {
      ...c,
      isOpen: match.isOpen !== false,
      closedReason: match.closedReason ?? c.closedReason ?? null,
      photoName: c.photoName ?? match.photoName ?? null,
      photoAttribution: c.photoAttribution ?? match.photoAttribution ?? null,
      rating: c.rating ?? match.rating ?? null,
      ratingCount: c.ratingCount ?? match.ratingCount ?? null,
    };
  });
  const googleOnly = google.filter((g) => !catalogue.some((c) => isSamePlace(c, g)));

  // Taken in turns, the owner's first in each pair, so ten Location Stores that
  // merely mention the query in their address cannot crowd out every Google shop
  // that is named after it, nor the reverse. Each pick is checked against
  // everything already chosen: either source can list one shop twice.
  const merged: Establishment[] = [];
  const take = (row: Establishment | undefined) => {
    if (!row || merged.length >= limit) return;
    if (merged.some((chosen) => isSamePlace(chosen, row))) return;
    merged.push(row);
  };
  for (let i = 0; merged.length < limit && (i < enrichedCatalogue.length || i < googleOnly.length); i++) {
    take(enrichedCatalogue[i]);
    take(googleOnly[i]);
  }
  return merged;
}

export async function activeCategories(): Promise<CategoryRef[]> {
  const rows = await merchantCategoryRepository.findMany({ includeInactive: false });
  // The description too: a category claims the kinds of shop it names
  // (lib/places/establishmentCategory.ts). Non-Pabili categories (Schools, Banks,
  // Padala Outlets, Motor Trades) are filtered out so they never claim shops.
  return rows
    .filter((c: { name: string }) => isPabiliCategoryName(c.name))
    .map((c: { id: number; name: string; description?: string | null }) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
    }));
}

const NON_PABILI_STORE_PHRASES: ReadonlyArray<string> = [
  "motor trade",
  "motor parts",
  "auto parts",
  "motorcycle parts",
  "car repair",
  "motorcycle repair",
  "machine shop",
  "vulcanizing",
  "elementary school",
  "high school",
  "national high school",
  "integrated school",
  "academy of",
  "central school",
  "college of",
  "pera padala",
  "money transfer",
  "express padala",
  "rural bank",
  "universal bank",
  // Carwash
  "car wash",
  "auto wash",
  "car detailing",
  "auto detailing",
  // Salons
  "beauty salon",
  "hair salon",
  "nail salon",
  "barber shop",
  "hair and beauty",
  // Logistics & Express
  "logistics service",
  "logistics services",
  "courier service",
  "courier services",
  "cargo forwarder",
  "freight forwarder",
  "express courier",
  "logistics express",
  "freight service",
  "freight services",
  "shipping service",
  "shipping services",
  "cargo service",
  "cargo services",
  "j t express",
  "lbc express",
  "jrs express",
  "flash express",
  "2go express",
  "spx express",
  "shopee xpress",
  "dhl express",
  "palawan express",
  "ninja van",
  "ap cargo",
  "capitol cargo",
  "forwarding service",
  "trucking service",
  "hauling service",
  // Police Outposts & Stations
  "police outpost",
  "police station",
  "police stations",
  "police precinct",
  "police headquarters",
  "police community",
  "pnp station",
  "pnp outpost",
  "fire station",
  "gas station",
  "gasoline station",
  "petrol station",
  "bus station",
  "bus terminal",
  "public terminal",
  "transit station",
  "train station",
  "radio station",
  "tv station",
  "broadcasting station",
  // Government Offices
  "government office",
  "government offices",
  "government center",
  "government agency",
  "city hall",
  "municipal hall",
  "barangay hall",
  "town hall",
  "provincial capitol",
  "hall of justice",
  "registry of deeds",
  "bureau of",
  "department of",
  "commission on",
  "office of the",
  "civil service",
  "social security",
  "land transportation",
  "internal revenue",
  "agrarian reform",
  "public attorney",
  "health office",
  "treasurer office",
  "assessor office",
  "civil registrar",
  "post office",
  // Network / Telecom / ISP
  "cable network",
  "radio network",
  "tv network",
  "television network",
  "broadcasting network",
  "computer network",
  "network service",
  "network services",
  "internet service",
  "telecom service",
  "globe store",
  "smart store",
  "pldt office",
  "converge ict",
  "dito telecommunity",
  // Internet Cafe / Computer Shops
  "internet cafe",
  "internet cafes",
  "internet shop",
  "cyber cafe",
  "computer shop",
  "computer cafe",
  "computer center",
  "net cafe",
  "piso net",
  "gaming cafe",
  "gaming hub",
  "gaming center",
  "esports center",
  // Nightclubs / Bars / KTV
  "night club",
  "night clubs",
  "comedy club",
  "videoke bar",
  "karaoke bar",
  "ktv bar",
  "sports bar",
  "cocktail lounge",
  "beer house",
  "gentlemen club",
  "strip club",
  "adult entertainment",
];

const NON_PABILI_STORE_TOKENS = new Set([
  "school",
  "schools",
  "college",
  "university",
  "preschool",
  "bank",
  "banks",
  "atm",
  "bdo",
  "bpi",
  "metrobank",
  "landbank",
  "pnb",
  "chinabank",
  "rcbc",
  "padala",
  "remittance",
  "cebuana",
  "mlhuillier",
  "motorparts",
  // Carwash
  "carwash",
  // Salons
  "salon",
  "salons",
  "barbershop",
  "barber",
  "spa",
  // Logistics & Express
  "logistics",
  "logistic",
  "logicstics",
  "courier",
  "couriers",
  "cargo",
  "freight",
  "shipping",
  "forwarder",
  "forwarding",
  "trucking",
  "hauling",
  "lbc",
  "jrs",
  "ninjavan",
  "spx",
  "dhl",
  "fedex",
  "entrego",
  "2go",
  "express",
  "xpress",
  // Police Outposts & Stations
  "police",
  "outpost",
  "outposts",
  "precinct",
  "pnp",
  "bfp",
  "bjmp",
  "compac",
  "petron",
  "caltex",
  "seaoil",
  "flyingv",
  // Government Offices
  "government",
  "governments",
  "govt",
  "office",
  "offices",
  "municipal",
  "barangay",
  "capitol",
  "courthouse",
  "embassy",
  "lgu",
  "bir",
  "lto",
  "sss",
  "philhealth",
  "pagibig",
  "dswd",
  "comelec",
  "csc",
  "dti",
  "dole",
  "dpwh",
  "denr",
  "nbi",
  "psa",
  "dfa",
  "dilg",
  "deped",
  "tesda",
  "ched",
  // Network / Telecom / ISP
  "network",
  "networks",
  "networking",
  "telecom",
  "telecommunications",
  "isp",
  "pldt",
  "converge",
  "skycable",
  "broadband",
  // Internet Cafe / Computer Shops
  "internet",
  "cybercafe",
  "netcafe",
  "icafe",
  "pisonet",
  "esports",
  "computershop",
  // Nightclubs / Bars / KTV
  "nightclub",
  "nightclubs",
  "disco",
  "discotheque",
  "ktv",
  "beerhouse",
  "restobar",
  "pub",
  "nightlife",
  "videoke",
  "karaoke",
  "casino",
  "gambling",
]);

const WATER_STATION_ALLOW_TOKENS = new Set([
  "water",
  "refilling",
  "purified",
  "alkaline",
  "mineral",
  "aquabest",
  "tubig",
]);

function isNonPabiliText(rawText: string): boolean {
  const norm = String(rawText ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return false;

  for (const phrase of NON_PABILI_STORE_PHRASES) {
    if (norm.includes(phrase)) return true;
  }

  const words = new Set(norm.split(" "));
  for (const token of NON_PABILI_STORE_TOKENS) {
    if (words.has(token)) return true;
  }

  // Block "station" / "stations" (Police Station, Gas Station, Bus Station, Fire Station,
  // Radio/TV Station, or a bare "Stations" search) unless it is a Water Refilling Station.
  if (words.has("station") || words.has("stations")) {
    const isWaterRefilling = [...WATER_STATION_ALLOW_TOKENS].some((w) => words.has(w));
    if (!isWaterRefilling) return true;
  }

  return false;
}

/**
 * Returns false when the customer's search query itself is asking for a
 * non-Pabili destination (Police Outpost/Stations, Government Offices, Network,
 * Internet Cafe, Nightclub, Logistics, Express, Schools, Banks, Salons, Carwash, etc.).
 */
export function isPabiliSearchQuery(query: string | null | undefined): boolean {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return true;
  if (!isPabiliCategoryName(trimmed)) return false;
  return !isNonPabiliText(trimmed);
}

const MALL_SECONDARY_FINANCE_TYPES = new Set(["atm", "bank", "money_transfer", "finance"]);
const MALL_CONTAINER_TYPES = new Set(["shopping_mall", "department_store", "supermarket"]);

function hasPabiliRetailOrFoodType(googlePlace: GooglePlace): boolean {
  if (!Array.isArray(googlePlace.types) || googlePlace.types.length === 0) return true;
  return googlePlace.types.some(
    (t) =>
      t === "store" ||
      t === "food" ||
      t === "market" ||
      t === "grocery_or_supermarket" ||
      t === "meal_delivery" ||
      t === "food_court" ||
      t === "diner" ||
      SEARCHABLE_TYPES.includes(t) ||
      /_(store|shop|restaurant|market|pharmacy|bakery|cafe)$/.test(t)
  );
}

/**
 * Ensures an establishment is a valid Pabili merchant (not a School, Bank,
 * Padala/Remittance center, Motor trade/repair shop, Police station/outpost,
 * Government office, Network/Telecom office, Internet cafe, Nightclub/Bar,
 * or Logistics/Express courier).
 */
export function isPabiliStore(
  store: Establishment,
  googlePlace?: GooglePlace | null
): boolean {
  // 1. If assigned category is non-Pabili, prune it
  if (store.categoryName && !isPabiliCategoryName(store.categoryName)) {
    return false;
  }

  // 2. If Google place types indicate non-Pabili
  if (googlePlace) {
    if (googlePlace.primaryType && NON_PABILI_GOOGLE_TYPES.has(googlePlace.primaryType)) {
      return false;
    }
    const blockedSecondary = googlePlace.types.filter((t) => NON_PABILI_GOOGLE_TYPES.has(t));
    if (blockedSecondary.length > 0) {
      // Only a shopping mall / supermarket / department store may carry an in-store ATM/bank tag;
      // any other non-Pabili type (e.g. internet_cafe, night_club, bar, police, government_office,
      // courier_service, telecommunications_service_provider, gas_station) is strictly rejected.
      const isMajorMallOrSupermarket = googlePlace.types.some((t) => MALL_CONTAINER_TYPES.has(t));
      const onlyInStoreFinance = blockedSecondary.every((t) => MALL_SECONDARY_FINANCE_TYPES.has(t));
      if (!isMajorMallOrSupermarket || !onlyInStoreFinance) {
        return false;
      }
    }
    if (!hasPabiliRetailOrFoodType(googlePlace)) {
      return false;
    }
  }

  // 3. Reject ghost places whose name is purely a street or road name
  if (isStreetOnlyName(store.name)) {
    return false;
  }

  // 4. Store name check
  if (isNonPabiliText(store.name)) {
    return false;
  }

  return true;
}

/** The catalogue's shops nearest `centre`, for when Google cannot answer a "near me" list. */
/**
 * The owner's Location Stores near `centre`, nearest first (2026-10-13): they
 * join Google's shops in "Stores near you", so a store Google Maps does not
 * list (owner-pinned) is found without typing its name.
 */
export const NEARBY_CATALOGUE_METERS = 3000;
async function nearbyCataloguePlaces(centre: GeoPoint): Promise<IVerifiedPlace[]> {
  const places = await placeService.searchPlaces({});
  return places
    .map((place) => ({ place, distance: metres(centre, place) }))
    .filter(({ distance }) => distance <= NEARBY_CATALOGUE_METERS)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, CANDIDATE_LIMIT)
    .map(({ place }) => place);
}

async function nearestCatalogue(centre: GeoPoint, near: GeoPoint | null): Promise<Establishment[]> {
  const places = await placeService.searchPlaces({});
  return places
    .map((place) => ({ place, distance: metres(centre, place) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, CANDIDATE_LIMIT)
    .map(({ place }) => fromCatalogue(place, near));
}

/** One store visit from a past errand (errand_pinpoints), as the ranking reads it. */
export interface PastOrderPin {
  errandId: string;
  customerId: number;
  orderedAt: Date;
  storeName: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
}

/** What past orders say about one store, for lib/places/storeRanking.ts. */
export interface StoreHistory {
  /** The searching customer's own orders here, each weighted by recency. */
  personal: number;
  /** Other customers' orders here in the last POPULARITY_WINDOW_DAYS, weighted by recency. */
  popular: number;
  orderedBefore: boolean;
  /** Historical Philippine-time hours (0.0 to 23.99 in UTC+8) when orders were placed at this store. */
  orderHoursPh?: number[];
}

const PH_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Converts any Date to its fractional hour of day (0.0 to 23.99) in Philippine Standard Time (UTC+8). */
export function toPhilippineHour(date: Date): number {
  const ph = new Date(date.getTime() + PH_OFFSET_MS);
  return ph.getUTCHours() + ph.getUTCMinutes() / 60;
}

export type StoreOperatingTier = "mall" | "convenience_24_7" | "fast_food_chain" | "regular_store";

const CONVENIENCE_24_7_PATTERNS: ReadonlyArray<string> = [
  "7-eleven",
  "7 eleven",
  "7-11",
  "ministop",
  "uncle john",
  "alfamart",
  "24/7",
  "24 hours",
  "24 hrs",
  "24hrs",
];

const FAST_FOOD_CHAIN_PATTERNS: ReadonlyArray<string> = [
  "jollibee",
  "jolibee",
  "mcdonald",
  "mc donald",
  "mcdo",
  "chowking",
  "mang inasal",
  "greenwich",
  "kfc",
  "burger king",
];

const MALL_AND_GIANT_SUPERMARKET_PATTERNS: ReadonlyArray<string> = [
  "kcc",
  "gaisano",
  "fitmart",
  "savemore",
  "save more",
  "robinsons",
  "puregold",
  "prince hypermart",
  "mr.diy",
  "mr diy",
  "citihardware",
  "citi hardware",
  "novo",
];

/**
 * Classifies a store into one of the three operating-hours tiers:
 * 1. `convenience_24_7`: Convenience stores in Tacurong (7-Eleven, Uncle John's, local convenience stores) -> open 24/7.
 * 2. `fast_food_chain`: Giant fast food chains (Jollibee, McDonald's, Chowking, Mang Inasal, Greenwich) -> follow Google Maps set time.
 * 3. `mall`: Malls, department stores, and major supermarkets (KCC, Gaisano, Fitmart, Savemore, Robinsons) -> follow Google Maps set closing time.
 * 4. `regular_store`: Small/regular local stores (bakeries, cafes, restaurants, local pharmacies, retail) -> expected hours calibrated by historical order data.
 */
export function classifyStoreOperatingTier(
  store: Pick<Establishment, "name" | "categoryName">,
  googlePlace?: GooglePlace | null
): StoreOperatingTier {
  const lowerName = store.name.toLowerCase();
  const lowerCat = (store.categoryName ?? "").toLowerCase();
  const types = new Set([
    ...(googlePlace?.types ?? []),
    ...(googlePlace?.primaryType ? [googlePlace.primaryType] : []),
  ]);

  if (
    types.has("convenience_store") ||
    lowerCat === "convenience store" ||
    CONVENIENCE_24_7_PATTERNS.some((p) => lowerName.includes(p))
  ) {
    return "convenience_24_7";
  }

  if (
    FAST_FOOD_CHAIN_PATTERNS.some((p) => lowerName.includes(p)) ||
    types.has("fast_food_restaurant")
  ) {
    return "fast_food_chain";
  }

  if (
    types.has("shopping_mall") ||
    types.has("department_store") ||
    types.has("supermarket") ||
    MALL_AND_GIANT_SUPERMARKET_PATTERNS.some((p) => lowerName.includes(p)) ||
    /\bmall\b/i.test(store.name)
  ) {
    return "mall";
  }

  return "regular_store";
}

function expectedRegularStoreWindowPh(
  store: Pick<Establishment, "name" | "categoryName">,
  googlePlace?: GooglePlace | null
): [number, number] {
  const lowerCat = (store.categoryName ?? "").toLowerCase();
  const lowerName = store.name.toLowerCase();
  const types = new Set([
    ...(googlePlace?.types ?? []),
    ...(googlePlace?.primaryType ? [googlePlace.primaryType] : []),
  ]);

  if (types.has("bakery") || lowerCat.includes("bakery") || lowerName.includes("bakery") || lowerName.includes("bakeshop") || lowerName.includes("market")) {
    // Bakeries & public market stalls in Tacurong open early (5:30 AM) and close around 8:30 PM
    return [5.5, 20.5];
  }
  if (types.has("pharmacy") || types.has("drugstore") || lowerCat.includes("pharmacy")) {
    // Pharmacies operate 7:00 AM to 9:00 PM (24/7 chains are handled via Google Maps openNow)
    return [7.0, 21.0];
  }
  if (
    types.has("cafe") ||
    types.has("coffee_shop") ||
    types.has("restaurant") ||
    lowerCat.includes("cafe") ||
    lowerCat.includes("restaurant") ||
    lowerCat.includes("food")
  ) {
    // Local cafes, carinderias & restaurants operate 6:30 AM to 9:00 PM
    return [6.5, 21.0];
  }
  // Retail, general merchandise, groceries, water refilling, pasalubong: 7:00 AM to 8:30 PM
  return [7.0, 20.5];
}

function circularHourDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 24;
  return diff > 12 ? 24 - diff : diff;
}

/**
 * Determines whether a store is currently open (`true`) or closed (`false`)
 * according to the 3-tier Tacurong City operating rules:
 * - Malls & Major Supermarkets: use Google Maps set closing time (fallback 8:00 AM - 8:00 PM PH time).
 * - 24/7 Convenience Stores: always open 24/7 unless Google Maps explicitly reports closed.
 * - Fast Food Chains (Jollibee, McDonald's, etc.): use Google Maps set time (24/7 branches stay open all night; non-24/7 branches close at their Google Maps closing time).
 * - Regular / Small Stores: use expected category operating hours calibrated by historical order timestamps (`history.orderHoursPh`).
 */
export function evaluateStoreOperatingStatus(
  store: Pick<Establishment, "name" | "categoryName" | "isOpen">,
  googlePlace?: GooglePlace | null,
  history?: StoreHistory | null,
  now?: Date | null
): boolean {
  if (googlePlace?.temporarilyClosed === true) return false;

  // A kept answer turns at the closing or opening time Google gave (googleOpenNowAt).
  const googleOpenNow = googlePlace ? googleOpenNowAt(googlePlace, now ?? new Date()) : undefined;
  const explicitGoogleOpen: boolean | null =
    googleOpenNow !== undefined
      ? googleOpenNow
      : googlePlace
        ? googlePlace.isOpen === false
          ? false
          : null
        : store.isOpen === false
          ? false
          : null;

  const tier = classifyStoreOperatingTier(store, googlePlace);
  const orderHours = history?.orderHoursPh ?? [];
  const phHour = now ? toPhilippineHour(now) : null;

  // 1. Convenience Stores in Tacurong: 24/7 open unless Google explicitly marks it closed
  if (tier === "convenience_24_7") {
    if (explicitGoogleOpen === false) return false;
    return true;
  }

  // 2. Fast Food Chains (Jollibee, McDonald's, etc.): follow Google Maps set time
  if (tier === "fast_food_chain") {
    if (typeof explicitGoogleOpen === "boolean") {
      return explicitGoogleOpen;
    }
    const lowerName = store.name.toLowerCase();
    if (
      lowerName.includes("mcdonald") ||
      lowerName.includes("mc donald") ||
      lowerName.includes("mcdo") ||
      lowerName.includes("drive-thru") ||
      lowerName.includes("drive thru")
    ) {
      return true;
    }
    if (phHour === null) return store.isOpen !== false;
    if (orderHours.some((h) => circularHourDistance(h, phHour) <= 1.5)) return true;
    return phHour >= 6.0 && phHour < 21.0;
  }

  // 3. Malls & Major Supermarkets: follow Google Maps set closing time
  if (tier === "mall") {
    if (typeof explicitGoogleOpen === "boolean") {
      return explicitGoogleOpen;
    }
    if (phHour === null) return store.isOpen !== false;
    if (orderHours.some((h) => circularHourDistance(h, phHour) <= 1.5)) return true;
    return phHour >= 8.0 && phHour < 20.0;
  }

  // 4. Regular / Small Stores: expected hours calibrated with historical order data
  const lowerName = store.name.toLowerCase();
  const isMajorPharmacyChain =
    lowerName.includes("mercury drug") ||
    lowerName.includes("rose pharmacy") ||
    lowerName.includes("watsons");
  if (isMajorPharmacyChain && typeof explicitGoogleOpen === "boolean") {
    return explicitGoogleOpen;
  }

  // If historical orders prove this small store fulfills orders around this hour of day,
  // trust the real historical evidence even if outside default expected hours.
  if (phHour !== null && orderHours.length > 0) {
    if (orderHours.some((h) => circularHourDistance(h, phHour) <= 1.5)) {
      return true;
    }
  }

  if (explicitGoogleOpen === false) {
    return false;
  }

  if (phHour === null) {
    return store.isOpen !== false;
  }

  let [openHour, closeHour] = expectedRegularStoreWindowPh(store, googlePlace);
  if (orderHours.length > 0) {
    const minHist = Math.min(...orderHours);
    const maxHist = Math.max(...orderHours);
    openHour = Math.max(0, Math.min(openHour, minHist - 0.5));
    closeHour = Math.min(24, Math.max(closeHour, maxHist + 1.0));
  }

  return phHour >= openHour && phHour < closeHour;
}

/** Formats a fractional Philippine-time hour (0.0 to 23.99) into 12-hour format (e.g. "7:00 AM", "5:30 AM"). */
export function formatPhHour12(hourFloat: number, snap15 = true): string {
  const normalized = ((hourFloat % 24) + 24) % 24;
  let totalMins = Math.round(normalized * 60);
  if (snap15) {
    totalMins = Math.round(totalMins / 15) * 15;
  }
  totalMins = totalMins % (24 * 60);
  const hours24 = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minStr = mins < 10 ? `0${mins}` : String(mins);
  return `${hours12}:${minStr} ${period}`;
}

/**
 * Produces a user-friendly notice for a closed store:
 * - `"Temporarily Unavailable"` when the store is temporarily closed or has no scheduled reopening hour.
 * - `"Opens at [12-hour format]"` (e.g. `"Opens at 8:00 AM"`, `"Opens at 5:30 AM"`) when a reopening time is known from Google Maps or Tacurong operating hours.
 */
export function resolveClosedStoreNotice(
  store: Pick<Establishment, "name" | "categoryName" | "isOpen">,
  googlePlace?: GooglePlace | null,
  history?: StoreHistory | null
): string {
  if (googlePlace?.temporarilyClosed === true) {
    return "Temporarily Unavailable";
  }

  if (googlePlace?.nextOpenTime) {
    const nextDate = new Date(googlePlace.nextOpenTime);
    if (!Number.isNaN(nextDate.getTime())) {
      return `Opens at ${formatPhHour12(toPhilippineHour(nextDate), false)}`;
    }
  }

  const tier = classifyStoreOperatingTier(store, googlePlace);
  if (tier === "convenience_24_7") {
    return "Temporarily Unavailable";
  }
  if (tier === "mall") {
    return "Opens at 8:00 AM";
  }
  if (tier === "fast_food_chain") {
    return "Opens at 6:00 AM";
  }

  let [openHour] = expectedRegularStoreWindowPh(store, googlePlace);
  const orderHours = history?.orderHoursPh ?? [];
  if (orderHours.length > 0) {
    const minHist = Math.min(...orderHours);
    openHour = Math.max(0, Math.min(openHour, minHist - 0.5));
  }
  return `Opens at ${formatPhHour12(openHour, true)}`;
}

/**
 * A past pin is this store when both name the same Location Store, or when the
 * names agree and the pins sit within SAME_PLACE_METERS, as isSamePlace decides.
 * A customer's pick is saved under the store's own name (errandService), so a
 * Google shop is found again the same way.
 */
function pinIsStore(pin: PastOrderPin, pinName: string, store: Establishment, storeName: string): boolean {
  if (pin.placeId && store.placeId) return pin.placeId === store.placeId;
  return storeName.length > 0 && storeName === pinName && metres(pin, store) <= SAME_PLACE_METERS;
}

/**
 * The customer's habits and everyone else's, per store. Each errand counts once
 * per store, however many pins it has there. The customer's own orders are kept
 * out of popularity, so one habit is not counted twice.
 */
export function tallyStoreHistory(
  stores: Establishment[],
  pins: PastOrderPin[],
  customerId: number | null,
  now: Date = new Date()
): Map<string, StoreHistory> {
  const pinNames = pins.map((pin) => normalizeStoreName(pin.storeName));
  const history = new Map<string, StoreHistory>();
  for (const store of stores) {
    const storeName = normalizeStoreName(store.name);
    const counted = new Set<string>();
    const tally: StoreHistory = { personal: 0, popular: 0, orderedBefore: false, orderHoursPh: [] };
    pins.forEach((pin, i) => {
      if (counted.has(pin.errandId) || !pinIsStore(pin, pinNames[i], store, storeName)) return;
      counted.add(pin.errandId);
      tally.orderHoursPh!.push(toPhilippineHour(pin.orderedAt));
      const ageDays = (now.getTime() - pin.orderedAt.getTime()) / DAY_MS;
      if (customerId !== null && pin.customerId === customerId) {
        tally.personal += recencyWeight(ageDays, PERSONAL_HALF_LIFE_DAYS);
        tally.orderedBefore = true;
      } else if (ageDays <= POPULARITY_WINDOW_DAYS) {
        tally.popular += recencyWeight(ageDays, POPULARITY_HALF_LIFE_DAYS);
      }
    });
    history.set(store.key, tally);
  }
  return history;
}

/**
 * Past orders near the candidates, read once per search. A failure is logged
 * and ranks on distance and name alone: history improves the list, and must
 * never be the reason a customer sees no stores.
 */
async function loadStoreHistory(stores: Establishment[], customerId: number | null): Promise<Map<string, StoreHistory>> {
  if (stores.length === 0) return new Map();
  // A box around every candidate, padded a little past SAME_PLACE_METERS.
  const pad = 0.0005;
  const lats = stores.map((s) => s.latitude);
  const lngs = stores.map((s) => s.longitude);
  try {
    const rows = await prisma.errandPinpoint.findMany({
      where: {
        latitude: { gte: Math.min(...lats) - pad, lte: Math.max(...lats) + pad },
        longitude: { gte: Math.min(...lngs) - pad, lte: Math.max(...lngs) + pad },
        errand: {
          status: { not: "CANCELLED" },
          createdAt: { gte: new Date(Date.now() - HISTORY_WINDOW_DAYS * DAY_MS) },
        },
      },
      select: {
        errandId: true,
        storeName: true,
        latitude: true,
        longitude: true,
        placeId: true,
        errand: { select: { customerId: true, createdAt: true } },
      },
      orderBy: { id: "desc" },
      take: HISTORY_PIN_LIMIT,
    });
    const pins: PastOrderPin[] = rows.map((row) => ({
      errandId: row.errandId,
      customerId: row.errand.customerId,
      orderedAt: row.errand.createdAt,
      storeName: row.storeName,
      latitude: row.latitude,
      longitude: row.longitude,
      placeId: row.placeId,
    }));
    return tallyStoreHistory(stores, pins, customerId);
  } catch (error) {
    logger.warn(`Store ranking ran without order history: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}

/**
 * The Location list, recommended the way YouTube and TikTok recommend videos:
 * gather many candidates, score every one, show the best (lib/places/storeRanking.ts).
 *
 * `customerId` is the searching customer's own id, and only ever a customer's:
 * staff ids are a separate sequence that overlaps it, so a dispatcher's id
 * would pick up a stranger's order history.
 *
 * With `categoryId`, the list is that merchant category's stores instead
 * (categoryEstablishments below).
 */
export async function searchEstablishments(input: {
  query?: string | null;
  near?: GeoPoint | null;
  customerId?: number | null;
  /** The Home row's cards show photos; step 1's list does not, and pays for none. */
  withPhotos?: boolean;
  /** The API's own address, "https://api.sugo-express.org", for owner photo addresses (finishRows). */
  photoOrigin?: string | null;
  /** Only this merchant category's stores: Home's category tiles (2026-10-10). */
  categoryId?: number | null;
  /**
   * The nearby list (no `query`) a page at a time, for the "Stores near you"
   * screen (2026-10-11): rows `offset` to `offset + limit` of the ranked list,
   * at most NEARBY_MAX. Without them, the first NEARBY_LIMIT, as before.
   */
  offset?: number;
  limit?: number;
  /**
   * "Find stores" (2026-10-14): the nearby list with the best-ranked branch of
   * each featured brand first (FEATURED_STORE_BRANDS), each marked `featured`,
   * then the rest in the usual order. Ignored for a typed search.
   */
  featured?: boolean;
  /** Optional evaluation timestamp for operating-hours rules (defaults to current time). */
  now?: Date;
}): Promise<EstablishmentSearch> {
  const query = input.query?.trim() ?? "";
  // Safeguard: when the customer's location is outside the Tacurong service area,
  // do not list stores and notify the app that Sugo Express is not in their area.
  if (input.near && !isWithinServiceBuffer(input.near, 0.1)) {
    return {
      items: [],
      google: isGooglePlacesConfigured() ? "ok" : "unavailable",
      outsideServiceArea: true,
      ...(query ? {} : { hasMore: false }),
    };
  }
  const near = input.near ?? null;
  const centre = near ?? SERVICE_AREA_CENTRE;
  // Safeguard: when the customer's search query itself asks for a non-Pabili
  // destination (Police Outpost/Stations, Government Offices, Network, Internet Cafe,
  // Nightclub, Logistics, Express, etc.), return no stores immediately without
  // sending a text query to Google Places.
  if (query && !isPabiliSearchQuery(query)) {
    return {
      items: [],
      google: isGooglePlacesConfigured() ? "ok" : "unavailable",
    };
  }
  if (input.categoryId !== undefined && input.categoryId !== null) {
    return categoryEstablishments({ ...input, categoryId: input.categoryId, query, near, centre });
  }

  const [cataloguePlaces, googlePlaces, active] = await Promise.all([
    query ? placeService.searchPlaces({ search: query, limit: CANDIDATE_LIMIT }) : nearbyCataloguePlaces(centre),
    query ? textPlaces(query) : nearbyPlaces(centre),
    activeCategories(),
  ]);

  const google = isGooglePlacesConfigured() && googlePlaces !== null ? "ok" : "unavailable";

  // Stage 1, candidates: up to 20 from each source, each shop once. More than
  // are shown, so a search for a chain weighs every branch Google found.
  const googlePlaceById = new Map((googlePlaces ?? []).map((p) => [p.googlePlaceId, p]));
  const rawCandidates =
    !query && google === "unavailable"
      ? await nearestCatalogue(centre, near)
      : mergeEstablishments(
          cataloguePlaces.map((place) => fromCatalogue(place, near)),
          (googlePlaces ?? []).map((place) => fromGoogle(place, null, near)),
          Number.POSITIVE_INFINITY
        );
  const candidates = rawCandidates.filter((store) =>
    isPabiliStore(store, store.googlePlaceId ? googlePlaceById.get(store.googlePlaceId) : null)
  );

  // Stage 2, ranking: distance heaviest, then the customer's habits, then
  // everyone's, then how well the name answers the search.
  const history = await loadStoreHistory(candidates, input.customerId ?? null);
  const ranked = rankByRecommendation(
    candidates,
    (store) => ({
      distanceMeters: store.distanceMeters,
      personalOrders: history.get(store.key)?.personal ?? 0,
      popularOrders: history.get(store.key)?.popular ?? 0,
      nameMatch: query ? nameMatchScore(store.name, query) : 0,
      isVerified: store.isVerified,
    }),
    Boolean(query)
  );

  const now = input.now ?? new Date();
  if (query) {
    const shown = ranked.slice(0, ESTABLISHMENT_LIMIT);
    return { items: await finishRows(shown, googlePlaces, active, history, Boolean(input.withPhotos), now, input.photoOrigin), google };
  }
  // The featured brands first, for "Find stores" only; every other nearby list
  // (Home's row, "Stores near you") keeps the plain recommendation order.
  const { rows: ordered, featured } = input.featured
    ? featuredFirst(ranked, (store) => store.name, parseFeaturedBrands(FEATURED_STORE_BRANDS))
    : { rows: ranked, featured: new Set<Establishment>() };
  const all = ordered.slice(0, NEARBY_MAX);
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.max(1, Math.min(input.limit ?? NEARBY_LIMIT, NEARBY_MAX));
  const shown = all.slice(offset, offset + limit);
  const featuredKeys = new Set([...featured].map((store) => store.key));
  const items = await finishRows(shown, googlePlaces, active, history, Boolean(input.withPhotos), now, input.photoOrigin);
  return {
    items: input.featured ? items.map((item) => ({ ...item, featured: featuredKeys.has(item.key) })) : items,
    google,
    hasMore: offset + shown.length < all.length,
  };
}

const nearbyPool = new Map<string, { at: number; places: GooglePlace[] }>();

/**
 * The shops nearest `centre`, Google's answer kept two minutes per ~100 m, as
 * Popular Stores' is: Home's row and the "Stores near you" screen's pages read
 * one search, not one each. A refusal is not kept.
 */
async function nearbyPlaces(centre: GeoPoint): Promise<GooglePlace[] | null> {
  const key = `${centre.latitude.toFixed(3)},${centre.longitude.toFixed(3)}`;
  const kept = nearbyPool.get(key);
  if (kept && Date.now() - kept.at < SEARCH_POOL_MAX_AGE_MS) return kept.places;
  const places = await searchNearbyPlaces(centre);
  if (places === null) return null;
  nearbyPool.delete(key);
  if (nearbyPool.size >= POPULAR_POOL_CACHE_MAX) {
    const oldest = nearbyPool.keys().next().value;
    if (oldest !== undefined) nearbyPool.delete(oldest);
  }
  nearbyPool.set(key, { at: Date.now(), places });
  return places;
}

/**
 * Google's answer to `ask`, kept SEARCH_POOL_MAX_AGE_MS under `key` in the
 * nearby pool (2026-10-13): the same typed word or category list from the
 * next customer costs nothing. A refusal is not kept.
 */
async function keptSearch(key: string, ask: () => Promise<GooglePlace[] | null>): Promise<GooglePlace[] | null> {
  const kept = nearbyPool.get(key);
  if (kept && Date.now() - kept.at < SEARCH_POOL_MAX_AGE_MS) return kept.places;
  const places = await ask();
  if (places === null) return null;
  nearbyPool.delete(key);
  if (nearbyPool.size >= POPULAR_POOL_CACHE_MAX) {
    const oldest = nearbyPool.keys().next().value;
    if (oldest !== undefined) nearbyPool.delete(oldest);
  }
  nearbyPool.set(key, { at: Date.now(), places });
  return places;
}

/**
 * Google's shops for a typed search, kept per word typed. The search covers the
 * whole service area, not the customer's block, so one answer serves everyone.
 * Shorter than GOOGLE_MIN_QUERY_LENGTH asks Google nothing (an empty answer).
 */
function textPlaces(query: string): Promise<GooglePlace[] | null> {
  const words = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (words.length < GOOGLE_MIN_QUERY_LENGTH) return Promise.resolve([]);
  return keptSearch(`text:${words}`, () => searchPlacesByText(query));
}

/** ~1 km squares: a 5 km search moved a few hundred metres finds the same shops. */
function cityCell(centre: GeoPoint): string {
  return `${centre.latitude.toFixed(2)},${centre.longitude.toFixed(2)}`;
}

/**
 * The Location Stores among `shown`, with the owner's photo and hours: a
 * catalogue row by its id, a Google row by the Google Maps place the owner
 * registered (verified_places.googlePlaceId). Keyed by the row's `key`. A
 * failed read only costs the lists their owner photos and hours.
 */
async function ownerExtrasFor(shown: Establishment[]): Promise<Map<string, OwnerExtrasRow>> {
  const ids = shown.map((store) => store.placeId).filter((id): id is string => Boolean(id));
  const googleIds = shown.map((store) => store.googlePlaceId).filter((id): id is string => Boolean(id));
  let rows: OwnerExtrasRow[] = [];
  try {
    rows = (await placeRepository.findOwnerExtras(ids, googleIds)).filter((row) => row.isActive);
  } catch (error) {
    logger.warn(`Store lists ran without owner photos and hours: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byGoogleId = new Map(rows.filter((row) => row.googlePlaceId).map((row) => [row.googlePlaceId!, row]));
  const owned = new Map<string, OwnerExtrasRow>();
  for (const store of shown) {
    const row = (store.placeId && byId.get(store.placeId)) || (store.googlePlaceId && byGoogleId.get(store.googlePlaceId));
    if (row) owned.set(store.key, row);
  }
  return owned;
}

/** The owner's storefront photo address (GET /api/places/:id/photo), or null. */
function ownerPhotoUrl(row: OwnerExtrasRow | undefined, origin: string | null): string | null {
  if (!row?.photoUpdatedAt || !origin) return null;
  return `${origin}/api/places/${row.id}/photo?v=${row.photoUpdatedAt.getTime()}`;
}

/**
 * The last steps for the rows a list shows, and only those: categories (a
 * Google shop of a plain "store" type costs a model call, and candidates nobody
 * sees need none), "ordered before", and photo addresses when asked for. A row
 * that already has its category (the popular and category lists) keeps it.
 */
async function finishRows(
  shown: Establishment[],
  googlePlaces: GooglePlace[] | null,
  active: CategoryRef[],
  history: Map<string, StoreHistory>,
  withPhotos: boolean,
  now: Date = new Date(),
  photoOrigin: string | null = null
): Promise<Establishment[]> {
  const placeById = new Map((googlePlaces ?? []).map((place) => [place.googlePlaceId, place]));
  const owned = await ownerExtrasFor(shown);
  const shownGoogle = shown.filter(
    (store) => store.categoryId === null && store.googlePlaceId && placeById.has(store.googlePlaceId)
  );
  const categories = await categorizeGooglePlaces(
    shownGoogle.map((store) => placeById.get(store.googlePlaceId!)!),
    active
  );
  const categoryOf = new Map(shownGoogle.map((store, i) => [store.key, categories[i]]));

  // The owner's own storefront photo costs nothing and is ours to keep, so a
  // store that has one never asks Google for its photo (2026-10-13).
  const ownPhotoUrls = shown.map((store) => ownerPhotoUrl(owned.get(store.key), photoOrigin));
  const photoUrls = withPhotos
    ? await resolvePhotoUris(shown.map((store, i) => (ownPhotoUrls[i] ? null : store.photoName)))
    : shown.map(() => null);

  return shown.map((store, i) => {
    const category = categoryOf.get(store.key);
    const resolvedStore: Establishment = {
      ...store,
      ...(category !== undefined ? { categoryId: category?.id ?? null, categoryName: category?.name ?? null } : {}),
    };
    const googlePlace =
      (resolvedStore.googlePlaceId ? placeById.get(resolvedStore.googlePlaceId) ?? null : null) ??
      (googlePlaces ?? []).find((p) => isSamePlace(resolvedStore, fromGoogle(p, null, null))) ??
      null;
    const storeHistory = history.get(store.key) ?? null;
    const own = owned.get(store.key);
    // The owner's hours are what the shop keeps; they beat every estimate.
    const hours = own ? parseWeeklyHours(own.openingHours) : null;
    const isOpen =
      hours && googlePlace?.temporarilyClosed !== true
        ? isOpenByHours(hours, now)
        : evaluateStoreOperatingStatus(resolvedStore, googlePlace, storeHistory, now);
    return {
      ...resolvedStore,
      // A Google shop the owner registered is that Location Store: the pick keeps its id.
      ...(own ? { placeId: own.id, isVerified: true } : {}),
      isOpen,
      closedReason: isOpen
        ? null
        : hours && googlePlace?.temporarilyClosed !== true
          ? nextOpeningNotice(hours, now)
          : resolveClosedStoreNotice(resolvedStore, googlePlace, storeHistory),
      orderedBefore: storeHistory?.orderedBefore ?? false,
      photoUrl: ownPhotoUrls[i] ?? photoUrls[i],
      ...(ownPhotoUrls[i] ? { photoAttribution: null } : {}),
    };
  });
}

/**
 * A merchant category's stores (2026-10-10): Home's category tiles open the
 * store search on this list instead of a shopping list for "any Pharmacy".
 *
 * Google is asked for that category's kinds of shop only (KIND_SEARCH_TYPES,
 * as Popular Stores' gap-fill picks them), nearest first across the city; a
 * typed search inside the category asks as the plain search does. Either way a
 * Google shop is kept only if its own types file it under this category, so a
 * bakery cafe stays out of Restaurant. A category no Google kind maps to (one
 * the owner added) is searched by its name, keeping shops no other category
 * claims. The owner's Location Stores of the category are merged in, and the
 * list is ranked as the plain one is: distance first, then habits.
 */
async function categoryEstablishments(input: {
  categoryId: number;
  query: string;
  near: GeoPoint | null;
  centre: GeoPoint;
  customerId?: number | null;
  withPhotos?: boolean;
  /** The API's own address, "https://api.sugo-express.org", for owner photo addresses (finishRows). */
  photoOrigin?: string | null;
  now?: Date;
}): Promise<EstablishmentSearch> {
  const { categoryId, query, near, centre } = input;
  const active = await activeCategories();
  const category = active.find((c) => c.id === categoryId);
  // A category since switched off lists nothing, as the Home grid no longer shows it.
  if (!category) return { items: [], google: isGooglePlacesConfigured() ? "ok" : "unavailable" };

  const ids = constituentCategoryIds(category, active);
  const types = googleTypesFor(category, active);
  const [cataloguePlaces, found] = await Promise.all([
    placeService.searchPlaces(
      ids.size > 1
        ? query
          ? { search: query }
          : {}
        : query
          ? { categoryId, search: query, limit: CANDIDATE_LIMIT }
          : { categoryId }
    ),
    query
      ? textPlaces(query)
      : types.length > 0
        ? keptSearch(`${cityCell(centre)}:category:${category.id}`, () =>
            searchNearbyPlaces(centre, types, CATEGORY_RADIUS_METERS)
          )
        : textPlaces(category.name),
  ]);
  // A refused type search still has the category's name to go on.
  const googlePlaces =
    found === null && !query && types.length > 0 && isGooglePlacesConfigured()
      ? await textPlaces(category.name)
      : found;
  const google = isGooglePlacesConfigured() && googlePlaces !== null ? "ok" : "unavailable";

  const belongs = (place: GooglePlace) => placeBelongsToCategory(place, category, active);
  const matchingCataloguePlaces = cataloguePlaces
    .filter((place) => {
      const placeCatId = place.category?.id ?? place.categoryId ?? category.id;
      return placeCatId === category.id || ids.has(placeCatId);
    })
    .slice(0, CANDIDATE_LIMIT);
  const catGooglePlaceById = new Map((googlePlaces ?? []).map((p) => [p.googlePlaceId, p]));
  const rawCatCandidates = mergeEstablishments(
    matchingCataloguePlaces.map((place) => ({
      ...fromCatalogue(place, near),
      categoryId: category.id,
      categoryName: category.name,
    })),
    (googlePlaces ?? []).filter(belongs).map((place) => fromGoogle(place, category, near)),
    Number.POSITIVE_INFINITY
  );
  const candidates = rawCatCandidates.filter((store) =>
    isPabiliStore(store, store.googlePlaceId ? catGooglePlaceById.get(store.googlePlaceId) : null)
  );

  const history = await loadStoreHistory(candidates, input.customerId ?? null);
  const shown = rankByRecommendation(
    candidates,
    (store) => ({
      distanceMeters: store.distanceMeters,
      personalOrders: history.get(store.key)?.personal ?? 0,
      popularOrders: history.get(store.key)?.popular ?? 0,
      nameMatch: query ? nameMatchScore(store.name, query) : 0,
      isVerified: store.isVerified,
    }),
    Boolean(query)
  ).slice(0, CATEGORY_LIMIT);

  return {
    items: await finishRows(shown, googlePlaces, active, history, Boolean(input.withPhotos), input.now ?? new Date(), input.photoOrigin),
    google,
  };
}

/**
 * Category IDs whose Google types belong to `category`.
 * For a normal category, this is just `{ category.id }`.
 * For a compound category (e.g. "Fast Food & Restaurant", "Restaurants & Cafes")
 * whose types are claimed by narrower active categories ("Fast Food", "Restaurant", "Cafe"),
 * this always includes those narrower constituent categories whose singularized
 * name words are a subset of `category.name`, even if the compound category also
 * claims a type directly via its description. For a custom category ("Water Refilling"),
 * this is empty.
 */
function constituentCategoryIds(category: CategoryRef, active: CategoryRef[]): Set<number> {
  const direct = SEARCHABLE_TYPES.filter((type) => categoryForGoogleTypes([type], null, active)?.id === category.id);
  const targetWords = wordsOf(category.name);
  const subCategories = active.filter((other) => {
    if (other.id === category.id) return false;
    const otherWords = wordsOf(other.name);
    return otherWords.size > 0 && [...otherWords].every((w) => targetWords.has(w));
  });
  if (direct.length > 0 || subCategories.length > 0) {
    return new Set([category.id, ...subCategories.map((c) => c.id)]);
  }
  return new Set();
}

/**
 * Google's types that file under `category`, each tested alone against the live
 * categories (SEARCHABLE_TYPES): its claims by name and description, then the
 * built-in kinds. None for a custom category no type files under.
 */
export function googleTypesFor(category: CategoryRef, active: CategoryRef[]): string[] {
  const ids = constituentCategoryIds(category, active);
  if (ids.size === 0) return [];
  return SEARCHABLE_TYPES.filter((type) => {
    const matched = categoryForGoogleTypes([type], null, active);
    return matched !== null && ids.has(matched.id);
  });
}

function placeBelongsToCategory(place: GooglePlace, category: CategoryRef, active: CategoryRef[]): boolean {
  const ids = constituentCategoryIds(category, active);
  const own = categoryForGoogleTypes(place.types, place.primaryType, active);
  if (ids.size > 0) {
    return own !== null && ids.has(own.id);
  }
  // Custom owner category with no Google type mapping (e.g. "Water Refilling"):
  // keep places from the category-name text search that no other active category claims,
  // or whose own store name explicitly contains all words of the custom category name.
  if (own === null) return true;
  const targetWords = wordsOf(category.name);
  const placeWords = wordsOf(place.name);
  return targetWords.size > 0 && [...targetWords].every((w) => placeWords.has(w));
}

/**
 * The Home tab's "Popular Stores" (2026-10-09): the best-rated shop of each
 * merchant category within about 5 km, those winners best rated first, six to
 * a page. Distance is shown, not ranked on (unless the customer sorts by it): a
 * well-rated shop across town is still popular.
 *
 * Mixed by category because one search over every kind of shop came back six
 * cafes and restaurants, which collect most of Tacurong's Google reviews.
 * Ratings are the dearest Places tier, so it asks as little as it can:
 *   1. two searches, food and everything else, each Google's 20 most popular;
 *   2. one more for each active category those two found no rated shop for,
 *      over just that category's kinds of shop;
 *   3. the best rated of each category (lib/places/storeRanking.ts
 *      bestRatedPerGroup), the winners best rated first.
 * Usually two requests; a category Tacurong has no rated shop for costs one more.
 *
 * No fallback to the owner's Location Stores when Google cannot answer: they
 * carry no ratings, so "popular" would mean nothing. The app says the list is
 * unavailable instead.
 *
 * Paged since 2026-10-10: the Popular Stores screen loads more as the customer
 * scrolls, up to POPULAR_MAX. The category winners come first, then every other
 * rated shop with a merchant category, best rated first; `sort` reorders that
 * same set (lib/places/storeRanking.ts orderPopular). Only the page's rows get
 * categories, history and photos, and the searches behind the set are kept for
 * two minutes, so the next page costs no new search.
 */
/** Default limit when fetching popular stores for a specific merchant category. */
export const POPULAR_CATEGORY_LIMIT = 10;

export async function popularEstablishments(input: {
  near?: GeoPoint | null;
  customerId?: number | null;
  withPhotos?: boolean;
  /** The API's own address, "https://api.sugo-express.org", for owner photo addresses (finishRows). */
  photoOrigin?: string | null;
  categoryId?: number | null;
  offset?: number;
  limit?: number;
  sort?: PopularSort;
  now?: Date;
}): Promise<PopularStoresPage> {
  if (input.near && !isWithinServiceBuffer(input.near, 0.1)) {
    return {
      items: [],
      google: isGooglePlacesConfigured() ? "ok" : "unavailable",
      total: 0,
      hasMore: false,
      outsideServiceArea: true,
    };
  }
  const near = input.near ?? null;
  const centre = near ?? SERVICE_AREA_CENTRE;

  if (input.categoryId !== undefined && input.categoryId !== null) {
    return popularCategoryEstablishments({
      ...input,
      categoryId: input.categoryId,
      near,
      centre,
    });
  }

  const { places, active } = await popularPlaces(centre);
  if (!isGooglePlacesConfigured() || places === null) {
    return { items: [], google: "unavailable", total: 0, hasMore: false };
  }

  const categoryOf = (place: GooglePlace) => categoryForGoogleTypes(place.types, place.primaryType, active);
  const ratedWinners = bestRatedPerGroup(places, (place) => categoryOf(place)?.id ?? null, POPULAR_MAX);
  // A category only the gap searches found (no ratings, 2026-10-13) is won by
  // its first shop in Google's popularity order, after the rated winners.
  const wonGroups = new Set(ratedWinners.map((place) => categoryOf(place)?.id));
  const unratedWinners: GooglePlace[] = [];
  for (const place of places) {
    const group = categoryOf(place)?.id;
    if (place.rating !== null || group === undefined || wonGroups.has(group)) continue;
    wonGroups.add(group);
    unratedWinners.push(place);
  }
  const winners = [...ratedWinners, ...unratedWinners];
  const winnerIds = new Set(winners.map((place) => place.googlePlaceId));
  // With no ratings at all (the Enterprise allowance used up), every shop with
  // a category follows in Google's popularity order.
  const anyRated = places.some((p) => p.rating !== null);
  const rest = rankByRating(
    places.filter(
      (p) => (!anyRated || p.rating !== null) && categoryOf(p) !== null && !winnerIds.has(p.googlePlaceId)
    )
  );
  const popPlaceById = new Map(places.map((p) => [p.googlePlaceId, p]));
  const rawSet = [...winners, ...rest].map((place) => fromGoogle(place, categoryOf(place), near));
  const set = rawSet
    .filter((store) => isPabiliStore(store, store.googlePlaceId ? popPlaceById.get(store.googlePlaceId) : null))
    .slice(0, POPULAR_MAX);

  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.max(1, Math.min(input.limit ?? POPULAR_LIMIT, POPULAR_MAX));
  const shown = orderPopular(set, input.sort ?? "recommended").slice(offset, offset + limit);
  const history = await loadStoreHistory(shown, input.customerId ?? null);
  return {
    items: await finishRows(shown, places, active, history, Boolean(input.withPhotos), input.now ?? new Date(), input.photoOrigin),
    google: "ok",
    total: set.length,
    hasMore: offset + shown.length < set.length,
  };
}

async function popularCategoryEstablishments(input: {
  near: GeoPoint | null;
  centre: GeoPoint;
  customerId?: number | null;
  withPhotos?: boolean;
  /** The API's own address, "https://api.sugo-express.org", for owner photo addresses (finishRows). */
  photoOrigin?: string | null;
  categoryId: number;
  offset?: number;
  limit?: number;
  sort?: PopularSort;
  now?: Date;
}): Promise<PopularStoresPage> {
  const { near, centre, categoryId } = input;
  if (!isGooglePlacesConfigured()) {
    return { items: [], google: "unavailable", total: 0, hasMore: false };
  }

  const active = await activeCategories();
  const category = active.find((c) => c.id === categoryId);
  if (!category) {
    return { items: [], google: "ok", total: 0, hasMore: false };
  }

  const types = googleTypesFor(category, active);
  let places: GooglePlace[] | null = null;
  const key = `${cityCell(centre)}:popular-category:${category.id}`;
  const kept = popularPool.get(key);

  if (kept && Date.now() - kept.at < POPULAR_POOL_MAX_AGE_MS) {
    places = kept.places;
  } else {
    const initialFound =
      types.length > 0
        ? await searchPopularPlaces(centre, types)
        : await searchPlacesByText(category.name, { includeRatings: true });
    const found =
      initialFound === null && types.length > 0 && isGooglePlacesConfigured()
        ? await searchPlacesByText(category.name, { includeRatings: true })
        : initialFound;
    if (found !== null) {
      places = uniquePlaces(found);
      popularPool.delete(key);
      if (popularPool.size >= POPULAR_POOL_CACHE_MAX) {
        const oldest = popularPool.keys().next().value;
        if (oldest !== undefined) popularPool.delete(oldest);
      }
      popularPool.set(key, { at: Date.now(), places });
    }
  }

  if (places === null) {
    return { items: [], google: "unavailable", total: 0, hasMore: false };
  }

  // Without the Enterprise tier no shop has a rating: Google's popularity order stands in.
  const rated = places.some((p) => p.rating !== null);
  const matching = rankByRating(
    places.filter((p) => (!rated || p.rating !== null) && placeBelongsToCategory(p, category, active))
  );
  const popPlaceById = new Map(places.map((p) => [p.googlePlaceId, p]));
  const set = matching
    .map((place) => fromGoogle(place, category, near))
    .filter((store) => isPabiliStore(store, store.googlePlaceId ? popPlaceById.get(store.googlePlaceId) : null))
    .slice(0, POPULAR_MAX);

  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.max(1, Math.min(input.limit ?? POPULAR_CATEGORY_LIMIT, POPULAR_MAX));
  const shown = orderPopular(set, input.sort ?? "recommended").slice(offset, offset + limit);
  const history = await loadStoreHistory(shown, input.customerId ?? null);
  return {
    items: await finishRows(shown, places, active, history, Boolean(input.withPhotos), input.now ?? new Date(), input.photoOrigin),
    google: "ok",
    total: set.length,
    hasMore: offset + shown.length < set.length,
  };
}

export interface PopularStoresPage extends EstablishmentSearch {
  /** How many popular stores there are in all, at most POPULAR_MAX. */
  total: number;
  /** Another page follows this one. */
  hasMore: boolean;
}

const popularPool = new Map<string, { at: number; places: GooglePlace[] }>();

/** Tests only: each test starts with no remembered popular or nearby searches. */
export function clearPopularPool(): void {
  popularPool.clear();
  nearbyPool.clear();
}

/**
 * Google's popular shops around `centre` (steps 1 and 2 above): the two
 * searches, then one per category they left without a rated shop. Null when
 * Google could not answer. A successful answer is kept for two minutes per
 * ~100 m, the time a customer spends paging and re-sorting the screen.
 */
async function popularPlaces(centre: GeoPoint): Promise<{ places: GooglePlace[] | null; active: CategoryRef[] }> {
  const key = cityCell(centre);
  const kept = popularPool.get(key);
  if (kept && Date.now() - kept.at < POPULAR_POOL_MAX_AGE_MS) {
    return { places: kept.places, active: await activeCategories() };
  }

  const [food, shops, active] = await Promise.all([
    searchPopularPlaces(centre, POPULAR_FOOD_TYPES),
    searchPopularPlaces(centre, POPULAR_SHOP_TYPES),
    activeCategories(),
  ]);
  if (food === null && shops === null) return { places: null, active };

  const categoryOf = (place: GooglePlace) => categoryForGoogleTypes(place.types, place.primaryType, active);
  let places = uniquePlaces([...(food ?? []), ...(shops ?? [])]);

  // Fill the gaps: a category with no rated shop among the most popular gets a
  // search of its own, over the kinds of shop that file under it. Without
  // ratings (2026-10-13), the Pro tier: one per category on the dearest tier
  // used most of its free allowance, and Google's popularity order picks the
  // category's shop instead (popularEstablishments).
  const rated = places.some((p) => p.rating !== null);
  const covered = new Set(places.filter((p) => !rated || p.rating !== null).map((p) => categoryOf(p)?.id));
  const gaps = active
    .filter((category) => !covered.has(category.id))
    .map((category) => googleTypesFor(category, active))
    .filter((types) => types.length > 0);
  const filled = await Promise.all(gaps.map((types) => searchPopularPlaces(centre, types, { ratings: false })));
  places = uniquePlaces([...places, ...filled.flatMap((found) => found ?? [])]);

  popularPool.delete(key); // an expired entry moves to the newest end
  if (popularPool.size >= POPULAR_POOL_CACHE_MAX) {
    const oldest = popularPool.keys().next().value;
    if (oldest !== undefined) popularPool.delete(oldest);
  }
  popularPool.set(key, { at: Date.now(), places });
  return { places, active };
}

/** Each Google place once, first sighting kept: the searches overlap. */
function uniquePlaces(places: GooglePlace[]): GooglePlace[] {
  const seen = new Set<string>();
  return places.filter((place) => !seen.has(place.googlePlaceId) && Boolean(seen.add(place.googlePlaceId)));
}
