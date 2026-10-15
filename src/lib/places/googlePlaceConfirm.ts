import { getPlaceDetails, type GooglePlaceDetails } from "./googlePlacesClient.js";

/**
 * "Is this a real Google Maps place?" for the owner's Location Stores
 * (2026-10-13), answered once per place per half hour: the form's prefill and
 * the save that follows it a minute later read one Google request.
 */

const KEEP_MS = 30 * 60 * 1000;
const KEEP_MAX = 300;
const kept = new Map<string, { at: number; place: GooglePlaceDetails }>();

export class PlaceConfirmError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * The place as Google Maps has it, or a PlaceConfirmError the owner can act on:
 * 422 when Google has no such place (or lists it permanently closed), 503 when
 * Google could not be asked (down, or the free allowance used up).
 * `hours` also asks for its opening hours, at the dearer tier.
 */
export async function confirmGooglePlace(googlePlaceId: string, options?: { hours?: boolean }): Promise<GooglePlaceDetails> {
  const hours = Boolean(options?.hours);
  const known = kept.get(googlePlaceId);
  if (known && Date.now() - known.at < KEEP_MS && (!hours || known.place.openingPeriods !== null)) return known.place;

  const answer = await getPlaceDetails(googlePlaceId, { hours });
  if (answer.status === "not_found") {
    throw new PlaceConfirmError(422, "Google Maps has no such place. Search for the store on Google Maps again.");
  }
  if (answer.status === "unavailable") {
    // A refusal with hours asked for may only be the hours' allowance: try without.
    if (hours) return confirmGooglePlace(googlePlaceId);
    throw new PlaceConfirmError(503, "Google Maps could not be reached to confirm this store. Try again in a minute.");
  }
  if (answer.place.businessStatus === "CLOSED_PERMANENTLY") {
    throw new PlaceConfirmError(422, `Google Maps lists ${answer.place.name} as permanently closed.`);
  }
  if (kept.size >= KEEP_MAX) kept.delete(kept.keys().next().value!);
  kept.set(googlePlaceId, { at: Date.now(), place: answer.place });
  return answer.place;
}

/** Tests only. */
export function clearConfirmedPlaces(): void {
  kept.clear();
}
