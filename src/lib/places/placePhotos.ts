import { GOOGLE_PLACES_API_KEY } from "../../config/env.js";
import { logger } from "../logger.js";

/**
 * A shop's own photo, for the cards on the customer app's Home tab (2026-10-08).
 *
 * The app cannot ask Google itself: that needs the Places key, which must never
 * ship inside an APK. So when the Home row asks for its stores with `photos=1`,
 * the server asks Google for each photo's short-lived image address with its own
 * key and returns the addresses in the same reply. The image then comes from
 * Google's image host, which needs no key and no sign-in.
 *
 * Not a redirect route the image loader calls, which was the first version: the
 * phone's image loader sent no Authorization header, so every photo was refused
 * as signed out and every card fell back to its category picture.
 *
 * Each lookup is a billed Places request. The address is remembered for half an
 * hour, so customers near the same shops do not each pay for it, and only the
 * Home row's few cards ask (step 1's list shows no photos).
 */

/** Google's photo resource name. Checked strictly, because it is pasted into a Google URL. */
export const PHOTO_NAME = /^places\/[A-Za-z0-9_-]{1,300}\/photos\/[A-Za-z0-9_-]{1,1000}$/;

/** Cards are about 220 px wide; twice that stays sharp on a dense screen. */
export const PHOTO_WIDTH_PX = 480;

const REQUEST_TIMEOUT_MS = 4000;
/** Inside the lifetime Google gives an image address, with room to spare. */
const ADDRESS_TTL_MS = 30 * 60 * 1000;
const ADDRESS_CACHE_MAX = 500;

const addresses = new Map<string, { uri: string; at: number }>();

/**
 * The image address for one photo, or null when Google cannot give one (no key,
 * a refusal, a photo since removed, a timeout). Never throws: a missing photo
 * means the card shows its fallback, not an error.
 */
export async function resolvePhotoUri(photoName: string, now: number = Date.now()): Promise<string | null> {
  if (!PHOTO_NAME.test(photoName)) return null;

  const known = addresses.get(photoName);
  if (known && now - known.at < ADDRESS_TTL_MS) return known.uri;
  if (!GOOGLE_PLACES_API_KEY) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${PHOTO_WIDTH_PX}&skipHttpRedirect=true`,
      { headers: { "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY }, signal: controller.signal }
    );
    const data: any = await response.json().catch(() => null);
    const uri = typeof data?.photoUri === "string" ? data.photoUri : null;
    if (!response.ok || !uri || !isHttps(uri)) {
      logger.warn(`Google place photo refused (${data?.error?.status ?? `HTTP ${response.status}`}).`);
      return null;
    }
    if (addresses.size >= ADDRESS_CACHE_MAX) addresses.delete(addresses.keys().next().value!);
    addresses.set(photoName, { uri, at: now });
    return uri;
  } catch (error) {
    logger.warn(`Google place photo failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isHttps(uri: string): boolean {
  try {
    return new URL(uri).protocol === "https:";
  } catch {
    return false;
  }
}

/** All of a list's photo addresses at once, but never holding the list up past the budget. */
export const PHOTO_BUDGET_MS = 2500;

/**
 * Addresses for several photos, in order, null where a photo has none or
 * Google was too slow. Answers landing after the budget are dropped; they are
 * still remembered, so the next request gets them.
 */
export async function resolvePhotoUris(
  names: Array<string | null>,
  budgetMs: number = PHOTO_BUDGET_MS
): Promise<Array<string | null>> {
  const answers: Array<string | null> = names.map(() => null);
  const ask = Promise.all(
    names.map(async (name, i) => {
      if (name) answers[i] = await resolvePhotoUri(name);
    })
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  await Promise.race([ask, deadline]);
  clearTimeout(timer);
  return [...answers];
}

/** Tests only. */
export function clearPhotoAddresses(): void {
  addresses.clear();
}
