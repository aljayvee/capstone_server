import { IPlaceRepository, placeRepository } from "../repositories/placeRepository.js";
import type { GeoPoint } from "../lib/geo.js";
import { isWithinServiceArea, isWithinServiceBuffer, isServiceAreaConfigured } from "../lib/serviceArea.js";
import { IVerifiedPlace, PlaceCreateInput, PlaceUpdateInput, PlaceSearchFilters } from "../types/place.js";
import { triggerCategoryAutoLearning } from "./categoryRetrainingService.js";
import { haversineDistanceKm } from "../lib/geo.js";
import { confirmGooglePlace, PlaceConfirmError } from "../lib/places/googlePlaceConfirm.js";
import { describeDuplicate, findDuplicate, groupDuplicates, namesLookRelated } from "../lib/places/placeDuplicates.js";
import { searchPlacesByText } from "../lib/places/googlePlacesClient.js";
import { checkStoreLocation } from "./storeLocationGuard.js";
import { matchGooglePlace } from "../lib/places/googlePlaceMatch.js";
import { normalizeStoreName } from "./storePredictionService.js";

/**
 * How close a Google Maps shop of a related name must be to an owner's pin
 * before it counts as the same store, which the owner should choose from the
 * Google Maps search instead (checkOwnerPin).
 */
export const OWNER_PIN_GOOGLE_MATCH_METERS = 150;

/**
 * How far the owner may move a store's pin from where Google Maps puts it
 * (2026-10-13): far enough to sit on the door or the parking entrance, never
 * far enough to be a guess at another building.
 */
export const PIN_MAX_FROM_GOOGLE_METERS = 100;

/** The storefront photo's ceiling, as for a category picture. */
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** A refusal the controller answers with `status`, `error`, and what it is about (`details`). */
function refuse(status: number, message: string, details?: Record<string, unknown>): Error {
  const error: any = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

/** The image a data URI holds, if it really is the JPEG, PNG or WebP it says it is. */
function decodePhoto(dataUri: string, mimeType: string): Buffer | null {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(dataUri);
  if (!match || match[1] !== mimeType) return null;
  const bytes = Buffer.from(match[2], "base64");
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isWebp = bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  const ok = mimeType === "image/jpeg" ? isJpeg : mimeType === "image/png" ? isPng : isWebp;
  return ok && bytes.length > 0 && bytes.length <= MAX_PHOTO_BYTES ? bytes : null;
}

// How close a pin has to be before we are willing to call it "at" a place.
//
// Measured against the actual catalogue rather than guessed. The downtown rows
// sit 25-110 m apart (Jollibee Main to Greenwich is ~89 m, to Chowking ~95 m,
// Greenwich to Chowking ~62 m), so anything near 150 m would routinely reach a
// second establishment — and, worse, would label a customer's *home* with the
// name of a restaurant down the street. That address then goes to a rider.
//
// 50 m is roughly a building footprint: close enough that a pin dropped inside
// the premises still resolves, tight enough that standing outside on the road
// does not. A miss costs nothing — the caller falls back to a street address.
const REVERSE_LOOKUP_RADIUS_METERS = 50;

export interface ReverseLookupResult {
  place: IVerifiedPlace;
  distanceMeters: number;
}

export class PlaceService {
  constructor(private repo: IPlaceRepository = placeRepository) {}

  // Coordinate -> nearest verified establishment. This is the Tier-1 answer for
  // "what is at this pin": the catalogue holds real Tacurong POIs with names a
  // rider recognises, which is precisely what a device geocoder cannot produce
  // for a coordinate that has no street address of its own.
  async reverseLookup(point: GeoPoint): Promise<ReverseLookupResult | null> {
    // Outside the operating boundary there is nothing in the catalogue worth
    // matching, and any hit would be a stray row rather than a real answer.
    if (!isWithinServiceArea(point)) return null;

    return this.repo.findNearest(point, REVERSE_LOOKUP_RADIUS_METERS);
  }

  async searchPlaces(filters: PlaceSearchFilters = {}): Promise<IVerifiedPlace[]> {
    const places = await this.repo.findAll(filters);

    if (!filters.search || !filters.search.trim()) {
      return places;
    }

    const query = filters.search.trim().toLowerCase();

    // Strategy-based relevance ranking:
    // 1. Exact name match or starts with query (Rank 3)
    // 2. Keyword exact token match (Rank 2)
    // 3. Address or partial keyword match (Rank 1)
    return places.sort((a: IVerifiedPlace, b: IVerifiedPlace) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aKey = (a.keywords || "").toLowerCase();
      const bKey = (b.keywords || "").toLowerCase();

      const aScore = aName.startsWith(query) ? 3 : aKey.includes(query) ? 2 : 1;
      const bScore = bName.startsWith(query) ? 3 : bKey.includes(query) ? 2 : 1;

      return bScore - aScore;
    });
  }

  async getPlaceById(id: string): Promise<IVerifiedPlace | null> {
    return this.repo.findById(id);
  }

  async createPlace(input: PlaceCreateInput): Promise<IVerifiedPlace> {
    if (
      isServiceAreaConfigured() &&
      !isWithinServiceBuffer({ latitude: input.latitude, longitude: input.longitude }, 0.1)
    ) {
      const error: any = new Error("Place location is outside Tacurong City service area.");
      error.status = 422;
      throw error;
    }
    // Every Location Store is a Google Maps place (2026-10-13), never a guessed
    // pin; or, for a real store Google Maps does not list, one the owner pinned
    // on the map themselves.
    if (input.googlePlaceId) {
      await this.checkOnGoogle(input.googlePlaceId, input);
    } else if (input.ownerPinned) {
      await this.checkOwnerPin(input.name, input, input.confirmDuplicate);
    } else {
      throw refuse(
        422,
        "Find the store on Google Maps first, or, if Google Maps does not have it, pin it on the map yourself."
      );
    }
    await this.checkDuplicate({ ...input, googlePlaceId: input.googlePlaceId ?? null }, null, input.confirmDuplicate);
    const { confirmDuplicate: _confirmed, ...data } = input;
    data.ownerPinned = !input.googlePlaceId;
    const created = await this.repo.create(data);
    // A verified place is a shop the owner catalogued under a category: the
    // store model's best-labelled kind of row. Learned within minutes rather
    // than at the nightly retrain (the retrain is debounced, so a batch of
    // places costs one run).
    triggerCategoryAutoLearning({ reason: "verified place created" });
    return created;
  }

  async updatePlace(id: string, input: PlaceUpdateInput): Promise<IVerifiedPlace> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      const error: any = new Error("Place not found");
      error.status = 404;
      throw error;
    }
    // The Archive's Restore sends only { isActive: true }: a store with no
    // Google Maps link is brought back too (restorePlace), not refused.
    const keys = Object.keys(input).filter((k) => (input as any)[k] !== undefined);
    if (input.isActive === true && !existing.isActive && keys.length === 1) {
      return (await this.restorePlace(id)).place;
    }
    if (
      isServiceAreaConfigured() &&
      input.latitude !== undefined &&
      input.longitude !== undefined &&
      !isWithinServiceBuffer({ latitude: input.latitude, longitude: input.longitude }, 0.1)
    ) {
      const error: any = new Error("Place location is outside Tacurong City service area.");
      error.status = 422;
      throw error;
    }

    // A store stays a Google Maps place. A row from before 2026-10-13 that has
    // none may still be retired, or edited while retired; anything that keeps
    // or puts it in circulation needs its Google Maps place first.
    const googlePlaceId = input.googlePlaceId !== undefined ? input.googlePlaceId : existing.googlePlaceId ?? null;
    // A Google Maps place is never owner-pinned; otherwise the owner says so.
    const ownerPinned = googlePlaceId ? false : input.ownerPinned ?? existing.ownerPinned ?? false;
    const staysActive = input.isActive ?? existing.isActive;
    if (!googlePlaceId && !ownerPinned && staysActive) {
      throw refuse(
        422,
        "Link this store to its Google Maps place first, or, if Google Maps does not have it, pin it on the map yourself."
      );
    }
    // Moved by more than a metre: the form sends the pin back rounded to six
    // decimals, and an exact comparison read that rounding as a move.
    const moved =
      (input.latitude !== undefined || input.longitude !== undefined) &&
      haversineDistanceKm(existing, {
        latitude: input.latitude ?? existing.latitude,
        longitude: input.longitude ?? existing.longitude,
      }) *
        1000 >
        1;
    const relinked = googlePlaceId !== (existing.googlePlaceId ?? null);
    const renamed = input.name !== undefined && input.name !== existing.name;
    const at = { latitude: input.latitude ?? existing.latitude, longitude: input.longitude ?? existing.longitude };
    if (googlePlaceId && (moved || relinked)) await this.checkOnGoogle(googlePlaceId, at);
    const newlyPinned = ownerPinned && !existing.ownerPinned;
    if (ownerPinned && staysActive && (moved || newlyPinned || renamed)) {
      // The Google look-alike question only when the store first becomes the
      // owner's pin or changes its name; a moved pin is only checked for place.
      await this.checkOwnerPin(input.name ?? existing.name, at, input.confirmDuplicate, !(newlyPinned || renamed));
    }
    if (moved || relinked || renamed) {
      await this.checkDuplicate({ name: input.name ?? existing.name, ...at, googlePlaceId }, id, input.confirmDuplicate);
    }

    const { confirmDuplicate: _confirmed, ...data } = input;
    if (ownerPinned !== (existing.ownerPinned ?? false)) data.ownerPinned = ownerPinned;
    const updated = await this.repo.update(id, data);
    triggerCategoryAutoLearning({ reason: "verified place updated" });
    return updated;
  }

  async deletePlace(id: string): Promise<IVerifiedPlace> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      const error: any = new Error("Place not found");
      error.status = 404;
      throw error;
    }
    const deleted = await this.repo.delete(id);
    triggerCategoryAutoLearning({ reason: "verified place deleted" });
    return deleted;
  }

  async getCategories() {
    return this.repo.getCategories();
  }

  /** The pin must be the Google Maps place, give or take its door (PIN_MAX_FROM_GOOGLE_METERS). */
  private async checkOnGoogle(googlePlaceId: string, pin: { latitude: number; longitude: number }) {
    let google;
    try {
      google = await confirmGooglePlace(googlePlaceId);
    } catch (error) {
      if (error instanceof PlaceConfirmError) throw refuse(error.status, error.message);
      throw error;
    }
    const metres = Math.round(haversineDistanceKm(pin, google) * 1000);
    if (metres > PIN_MAX_FROM_GOOGLE_METERS) {
      throw refuse(
        422,
        `The pin is ${metres} m from where Google Maps puts ${google.name}. Keep it within ` +
          `${PIN_MAX_FROM_GOOGLE_METERS} m, at the store's door.`,
        { googleLatitude: google.latitude, googleLongitude: google.longitude }
      );
    }
  }

  /**
   * A store Google Maps does not list, pinned by the owner (2026-10-13). The pin
   * must be a place a rider can reach: inside Tacurong and beside a road
   * (storeLocationGuard, as the dispatcher's pins are checked). And Google Maps
   * is asked once whether it lists the store after all, near the pin: then the
   * owner should choose it there, unless they confirm it is a different store.
   * A Google outage never blocks the save: the owner's word stands.
   */
  private async checkOwnerPin(
    name: string,
    pin: { latitude: number; longitude: number },
    confirmed?: boolean,
    placeOnly = false
  ) {
    const verdict = await checkStoreLocation(pin);
    if (verdict.status === "blocked") throw refuse(422, verdict.message);
    if (placeOnly || confirmed) return;

    const found = await searchPlacesByText(name);
    const key = normalizeStoreName(name);
    const match = (found ?? [])
      .map((place) => ({ place, metres: Math.round(haversineDistanceKm(pin, place) * 1000) }))
      .filter(({ place, metres }) => metres <= OWNER_PIN_GOOGLE_MATCH_METERS && namesLookRelated(key, normalizeStoreName(place.name)))
      .sort((a, b) => a.metres - b.metres)[0];
    if (match) {
      throw refuse(
        409,
        `Google Maps lists "${match.place.name}" ${match.metres} m from your pin. Choose it from the Google Maps ` +
          `search instead, or, if it is a different store, confirm to pin yours anyway.`,
        {
          reason: "on_google",
          canConfirm: true,
          googleMatch: { googlePlaceId: match.place.googlePlaceId, name: match.place.name },
        }
      );
    }
  }

  /**
   * The same store registered twice (lib/places/placeDuplicates.ts): the same
   * Google Maps place is always refused; the same name, or a related name a few
   * metres away, only until the owner confirms it is another branch.
   */
  private async checkDuplicate(
    candidate: { name: string; latitude: number; longitude: number; googlePlaceId: string | null },
    excludeId: string | null,
    confirmed?: boolean
  ) {
    const rows = await this.repo.findAllForDuplicates();
    // Editing a store: a retired look-alike is history, not a clash (FitMart
    // Tacurong was refused for the retired "Tacurong Fitmart"). The same Google
    // Maps place still is, retired or not.
    const pool = excludeId
      ? rows.filter((row) => row.isActive || (candidate.googlePlaceId && row.googlePlaceId === candidate.googlePlaceId))
      : rows;
    const match = findDuplicate(candidate, pool, excludeId);
    if (!match || (match.reason !== "google_place" && confirmed)) return;
    const duplicateOf = { id: match.existing.id, name: match.existing.name, isActive: match.existing.isActive };
    if (match.reason === "google_place") {
      throw refuse(409, `${describeDuplicate(match)} Edit that one instead.`, { duplicateOf, canConfirm: false });
    }
    throw refuse(409, `${describeDuplicate(match)} If this is another branch, confirm to register it anyway.`, {
      duplicateOf,
      reason: match.reason,
      canConfirm: true,
    });
  }

  /**
   * A retired store back in circulation (2026-10-13). A store with no Google
   * Maps link and no owner pin (registered before linking) is linked to its
   * Google Maps place on the way back when Google has one by its name near its
   * pin, the pin moving to Google's; otherwise it comes back unlinked
   * (`linked: false`) and the portal asks the owner to link or pin it. The
   * owner asked to restore it, so a store Google does not know is no reason to
   * keep it retired.
   */
  async restorePlace(id: string): Promise<{ place: IVerifiedPlace; linked: boolean; alreadyActive: boolean }> {
    const existing = await this.repo.findById(id);
    if (!existing) throw refuse(404, "Place not found");
    const linkedAlready = Boolean(existing.googlePlaceId) || Boolean(existing.ownerPinned);
    if (existing.isActive) return { place: existing, linked: linkedAlready, alreadyActive: true };
    if (linkedAlready) {
      const place = await this.repo.update(id, { isActive: true });
      triggerCategoryAutoLearning({ reason: "verified place updated" });
      return { place, linked: true, alreadyActive: false };
    }

    const rows = await this.repo.findAllForDuplicates();
    const taken = new Set(rows.map((row) => row.googlePlaceId).filter(Boolean));
    const match = await matchGooglePlace(existing.name, existing, (googlePlaceId) => taken.has(googlePlaceId));
    const place =
      match.status === "matched"
        ? await this.repo.update(id, {
            isActive: true,
            googlePlaceId: match.place.googlePlaceId,
            latitude: match.place.latitude,
            longitude: match.place.longitude,
          })
        : await this.repo.update(id, { isActive: true });
    triggerCategoryAutoLearning({ reason: "verified place updated" });
    return { place, linked: match.status === "matched", alreadyActive: false };
  }

  /** Several retired stores back at once (the Archive's Restore selected), each as restorePlace. */
  async restorePlaces(ids: string[]) {
    const results: Array<{ id: string; name: string | null; restored: boolean; linked: boolean; error: string | null }> = [];
    for (const id of ids) {
      try {
        const { place, linked, alreadyActive } = await this.restorePlace(id);
        results.push({ id, name: place.name, restored: !alreadyActive, linked, error: null });
      } catch (error: any) {
        results.push({ id, name: null, restored: false, linked: false, error: error?.message ?? "Could not restore" });
      }
    }
    return results;
  }

  /** Every set of active stores that look like one store registered more than once. */
  async getDuplicateGroups() {
    const rows = (await this.repo.findAllForDuplicates()).filter((row) => row.isActive);
    return groupDuplicates(rows).map((group) => ({
      reason: group.reason,
      places: group.rows.map((row) => ({ id: row.id, name: row.name, categoryName: row.category?.name ?? null })),
    }));
  }

  /** The owner's storefront photo, from a data URI (2MB, JPEG/PNG/WebP). */
  async setPhoto(id: string, input: { imageData: string; mimeType: string }): Promise<{ photoUpdatedAt: Date }> {
    if (!(await this.repo.findById(id))) throw refuse(404, "Place not found");
    const bytes = decodePhoto(input.imageData, input.mimeType);
    if (!bytes) throw refuse(422, "That photo could not be read. Use a JPEG, PNG or WebP image of 2 MB or less.");
    const photoUpdatedAt = await this.repo.setPhoto(id, { imageData: bytes, mimeType: input.mimeType, fileSize: bytes.length });
    return { photoUpdatedAt };
  }

  async getPhoto(id: string) {
    return this.repo.getPhoto(id);
  }

  async deletePhoto(id: string): Promise<void> {
    if (!(await this.repo.findById(id))) throw refuse(404, "Place not found");
    await this.repo.deletePhoto(id);
  }
}

export const placeService = new PlaceService();
