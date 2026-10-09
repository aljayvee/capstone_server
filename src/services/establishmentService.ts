import { haversineDistanceKm, type GeoPoint } from "../lib/geo.js";
import {
  isGooglePlacesConfigured,
  searchNearbyPlaces,
  searchPlacesByText,
  searchPopularPlaces,
  KIND_SEARCH_TYPES,
  POPULAR_FOOD_TYPES,
  POPULAR_SHOP_TYPES,
  type GooglePlace,
} from "../lib/places/googlePlacesClient.js";
import {
  categorizeGooglePlaces,
  categoryForGoogleTypes,
  type CategoryRef,
} from "../lib/places/establishmentCategory.js";
import { resolvePhotoUris } from "../lib/places/placePhotos.js";
import {
  nameMatchScore,
  PERSONAL_HALF_LIFE_DAYS,
  POPULARITY_HALF_LIFE_DAYS,
  bestRatedPerGroup,
  rankByRecommendation,
  recencyWeight,
} from "../lib/places/storeRanking.js";
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
/** Stores considered before ranking picks the rows shown (lib/places/storeRanking.ts). */
export const CANDIDATE_LIMIT = 20;
/** The Home tab's "Popular Stores": 4 in its row, all 6 on "See all popular stores". */
export const POPULAR_LIMIT = 6;

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
  /** The Location Stores row, for a catalogue pick. Google picks have none. */
  placeId: string | null;
  googlePlaceId: string | null;
  categoryId: number | null;
  categoryName: string | null;
  /** From the point the customer searched near, when they gave one. */
  distanceMeters: number | null;
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
}

export interface EstablishmentSearch {
  items: Establishment[];
  /** "unavailable": Google could not answer, and the list is Location Stores alone. */
  google: "ok" | "unavailable";
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
    placeId: place.id,
    googlePlaceId: null,
    categoryId: place.category?.id ?? place.categoryId ?? null,
    categoryName: place.category?.name ?? null,
    distanceMeters: near ? metres(near, place) : null,
    orderedBefore: false,
    photoName: null,
    photoAttribution: null,
    photoUrl: null,
    rating: null,
    ratingCount: null,
  };
}

export function fromGoogle(place: GooglePlace, category: CategoryRef | null, near: GeoPoint | null): Establishment {
  return {
    key: `google:${place.googlePlaceId}`,
    source: "google",
    name: place.name,
    address: withoutPlusCode(place.address),
    latitude: place.latitude,
    longitude: place.longitude,
    placeId: null,
    googlePlaceId: place.googlePlaceId,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    distanceMeters: near ? metres(near, place) : null,
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
  // category and the placeId the pin keeps. Dropped from Google's side up front,
  // so the interleave below can never pick the Google copy first.
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
  for (let i = 0; merged.length < limit && (i < catalogue.length || i < googleOnly.length); i++) {
    take(catalogue[i]);
    take(googleOnly[i]);
  }
  return merged;
}

async function activeCategories(): Promise<CategoryRef[]> {
  const rows = await merchantCategoryRepository.findMany({ includeInactive: false });
  return rows.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name }));
}

/** The catalogue's shops nearest `centre`, for when Google cannot answer a "near me" list. */
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
    const tally: StoreHistory = { personal: 0, popular: 0, orderedBefore: false };
    pins.forEach((pin, i) => {
      if (counted.has(pin.errandId) || !pinIsStore(pin, pinNames[i], store, storeName)) return;
      counted.add(pin.errandId);
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
 */
export async function searchEstablishments(input: {
  query?: string | null;
  near?: GeoPoint | null;
  customerId?: number | null;
  /** The Home row's cards show photos; step 1's list does not, and pays for none. */
  withPhotos?: boolean;
}): Promise<EstablishmentSearch> {
  const query = input.query?.trim() ?? "";
  // A point outside the city ranks nothing useful; search from the centre.
  const near = input.near && isWithinServiceBuffer(input.near, 0.1) ? input.near : null;
  const centre = near ?? SERVICE_AREA_CENTRE;

  const [cataloguePlaces, googlePlaces, active] = await Promise.all([
    query ? placeService.searchPlaces({ search: query, limit: CANDIDATE_LIMIT }) : Promise.resolve([]),
    query ? searchPlacesByText(query) : searchNearbyPlaces(centre),
    activeCategories(),
  ]);

  const google = isGooglePlacesConfigured() && googlePlaces !== null ? "ok" : "unavailable";

  // Stage 1, candidates: up to 20 from each source, each shop once. More than
  // are shown, so a search for a chain weighs every branch Google found.
  const candidates =
    !query && google === "unavailable"
      ? await nearestCatalogue(centre, near)
      : mergeEstablishments(
          cataloguePlaces.map((place) => fromCatalogue(place, near)),
          (googlePlaces ?? []).map((place) => fromGoogle(place, null, near)),
          Number.POSITIVE_INFINITY
        );

  // Stage 2, ranking: distance heaviest, then the customer's habits, then
  // everyone's, then how well the name answers the search.
  const history = await loadStoreHistory(candidates, input.customerId ?? null);
  const limit = query ? ESTABLISHMENT_LIMIT : NEARBY_LIMIT;
  const shown = rankByRecommendation(
    candidates,
    (store) => ({
      distanceMeters: store.distanceMeters,
      personalOrders: history.get(store.key)?.personal ?? 0,
      popularOrders: history.get(store.key)?.popular ?? 0,
      nameMatch: query ? nameMatchScore(store.name, query) : 0,
    }),
    Boolean(query)
  ).slice(0, limit);

  return { items: await finishRows(shown, googlePlaces, active, history, Boolean(input.withPhotos)), google };
}

/**
 * The last steps for the rows a list shows, and only those: categories (a
 * Google shop of a plain "store" type costs a model call, and candidates nobody
 * sees need none), "ordered before", and photo addresses when asked for.
 */
async function finishRows(
  shown: Establishment[],
  googlePlaces: GooglePlace[] | null,
  active: CategoryRef[],
  history: Map<string, StoreHistory>,
  withPhotos: boolean
): Promise<Establishment[]> {
  const placeById = new Map((googlePlaces ?? []).map((place) => [place.googlePlaceId, place]));
  const shownGoogle = shown.filter((store) => store.googlePlaceId && placeById.has(store.googlePlaceId));
  const categories = await categorizeGooglePlaces(
    shownGoogle.map((store) => placeById.get(store.googlePlaceId!)!),
    active
  );
  const categoryOf = new Map(shownGoogle.map((store, i) => [store.key, categories[i]]));

  const photoUrls = withPhotos ? await resolvePhotoUris(shown.map((store) => store.photoName)) : shown.map(() => null);

  return shown.map((store, i) => {
    const category = categoryOf.get(store.key);
    return {
      ...store,
      ...(category !== undefined ? { categoryId: category?.id ?? null, categoryName: category?.name ?? null } : {}),
      orderedBefore: history.get(store.key)?.orderedBefore ?? false,
      photoUrl: photoUrls[i],
    };
  });
}

/**
 * The Home tab's "Popular Stores" (2026-10-09): the best-rated shop of each
 * merchant category within about 5 km, those winners best rated first, six of
 * them. Distance is shown, not ranked on: a well-rated shop across town is
 * still popular.
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
 */
export async function popularEstablishments(input: {
  near?: GeoPoint | null;
  customerId?: number | null;
  withPhotos?: boolean;
}): Promise<EstablishmentSearch> {
  const near = input.near && isWithinServiceBuffer(input.near, 0.1) ? input.near : null;
  const centre = near ?? SERVICE_AREA_CENTRE;

  const [food, shops, active] = await Promise.all([
    searchPopularPlaces(centre, POPULAR_FOOD_TYPES),
    searchPopularPlaces(centre, POPULAR_SHOP_TYPES),
    activeCategories(),
  ]);
  if (!isGooglePlacesConfigured() || (food === null && shops === null)) return { items: [], google: "unavailable" };

  const categoryOf = (place: GooglePlace) => categoryForGoogleTypes(place.types, place.primaryType, active);
  let places = uniquePlaces([...(food ?? []), ...(shops ?? [])]);

  // Fill the gaps: a category with no rated shop among the most popular gets a
  // search of its own, over the kinds of shop that file under it.
  const covered = new Set(places.filter((p) => p.rating !== null).map((p) => categoryOf(p)?.id));
  const gaps = active
    .filter((category) => !covered.has(category.id))
    .map((category) =>
      Object.values(KIND_SEARCH_TYPES)
        .filter((types) => categoryForGoogleTypes(types, null, active)?.id === category.id)
        .flat()
    )
    .filter((types) => types.length > 0);
  const filled = await Promise.all(gaps.map((types) => searchPopularPlaces(centre, types)));
  places = uniquePlaces([...places, ...filled.flatMap((found) => found ?? [])]);

  const winners = bestRatedPerGroup(places, (place) => categoryOf(place)?.id ?? null, POPULAR_LIMIT);
  const shown = winners.map((place) => fromGoogle(place, categoryOf(place), near));
  const history = await loadStoreHistory(shown, input.customerId ?? null);
  return { items: await finishRows(shown, places, active, history, Boolean(input.withPhotos)), google: "ok" };
}

/** Each Google place once, first sighting kept: the searches overlap. */
function uniquePlaces(places: GooglePlace[]): GooglePlace[] {
  const seen = new Set<string>();
  return places.filter((place) => !seen.has(place.googlePlaceId) && Boolean(seen.add(place.googlePlaceId)));
}
