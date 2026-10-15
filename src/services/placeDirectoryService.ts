import {
  CATEGORY_RADIUS_METERS,
  searchNearbyPlaces,
  searchPlacesByText,
  type GooglePlace,
} from "../lib/places/googlePlacesClient.js";
import { categoryForGoogleTypes } from "../lib/places/establishmentCategory.js";
import { confirmGooglePlace, PlaceConfirmError } from "../lib/places/googlePlaceConfirm.js";
import { findDuplicate } from "../lib/places/placeDuplicates.js";
import { weeklyHoursFromGoogle } from "../lib/places/storeHours.js";
import { SERVICE_AREA_CENTRE } from "../lib/serviceArea.js";
import { placeRepository, type DirectoryDuplicateRow } from "../repositories/placeRepository.js";
import { activeCategories, googleTypesFor, withoutPlusCode } from "./establishmentService.js";

/**
 * The owner portal's way into Google Maps (2026-10-13): Location Stores are
 * registered from the stores Google Maps knows, never typed in with a guessed
 * pin. Search by words or by a merchant category's kinds of shop; each result
 * says whether it is already registered. Then one place's details prefill the
 * form: name, address, barangay, position, suggested category, opening hours.
 */

export interface DirectoryRegistration {
  id: string;
  name: string;
  isActive: boolean;
}

export interface GoogleDirectoryResult {
  googlePlaceId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  categoryId: number | null;
  categoryName: string | null;
  /** The Location Store that is this Google Maps place. */
  registered: DirectoryRegistration | null;
  /** A Location Store with the same or a related name nearby, not linked to this place. */
  looksLike: DirectoryRegistration | null;
}

function refuse(status: number, message: string): Error {
  const error: any = new Error(message);
  error.status = status;
  return error;
}

const registration = (row: DirectoryDuplicateRow): DirectoryRegistration => ({
  id: row.id,
  name: row.name,
  isActive: row.isActive,
});

export async function searchGoogleForDirectory(input: { q?: string; categoryId?: number }): Promise<GoogleDirectoryResult[]> {
  const active = await activeCategories();
  let places: GooglePlace[] | null;
  if (input.q && input.q.trim().length >= 2) {
    places = await searchPlacesByText(input.q.trim());
  } else {
    const category = active.find((c) => c.id === input.categoryId);
    if (!category) throw refuse(404, "That merchant category is not active.");
    const types = googleTypesFor(category, active);
    places =
      types.length > 0
        ? await searchNearbyPlaces(SERVICE_AREA_CENTRE, types, CATEGORY_RADIUS_METERS)
        : await searchPlacesByText(category.name);
  }
  if (places === null) throw refuse(503, "Google Maps could not be searched right now. Try again in a minute.");

  const rows = await placeRepository.findAllForDuplicates();
  return places.map((place) => {
    const category = categoryForGoogleTypes(place.types, place.primaryType, active);
    const registered = rows.find((row) => row.googlePlaceId === place.googlePlaceId) ?? null;
    const similar = registered ? null : findDuplicate({ ...place, googlePlaceId: null }, rows);
    return {
      googlePlaceId: place.googlePlaceId,
      name: place.name,
      address: withoutPlusCode(place.address),
      latitude: place.latitude,
      longitude: place.longitude,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      registered: registered ? registration(registered) : null,
      looksLike: similar ? registration(similar.existing) : null,
    };
  });
}

/** One Google Maps place, ready to fill the Location Store form. */
export async function googlePlaceForDirectory(googlePlaceId: string) {
  let place;
  try {
    place = await confirmGooglePlace(googlePlaceId, { hours: true });
  } catch (error) {
    if (error instanceof PlaceConfirmError) throw refuse(error.status, error.message);
    throw error;
  }
  const active = await activeCategories();
  const category = categoryForGoogleTypes(place.types, place.primaryType, active);
  const registered = (await placeRepository.findAllForDuplicates()).find((row) => row.googlePlaceId === place.googlePlaceId);
  return {
    googlePlaceId: place.googlePlaceId,
    name: place.name,
    address: withoutPlusCode(place.address),
    barangay: place.barangay,
    latitude: place.latitude,
    longitude: place.longitude,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    temporarilyClosed: place.businessStatus === "CLOSED_TEMPORARILY",
    /** Google's hours as a week (lib/places/storeHours.ts); null when Google has none or they were not affordable. */
    openingHours: weeklyHoursFromGoogle(place.openingPeriods),
    registered: registered ? registration(registered) : null,
  };
}
