import { createHmac, timingSafeEqual } from "node:crypto";
import { JWT_SECRET } from "../config/env.js";

/**
 * Signed, keyless links to a customer's profile photo.
 *
 * The photo used to travel inline as base64 inside every profile, login and
 * token-refresh response: up to 740 KB each time (2026-11-04), which on a slow
 * mobile link is a 10+ second login. A link keeps those responses small; the
 * phone downloads the photo once and its image cache keeps it.
 *
 * Keyless because the app's image loader sends no Authorization header (see
 * GET /api/places/:id/photo). Signed over the customer id AND the photo's
 * version, so ids cannot be enumerated and a leaked link stops working as soon
 * as the photo changes.
 */

const SIGNATURE_LENGTH = 22; // base64url characters, 132 bits

function signature(customerId: number, version: number): string {
  return createHmac("sha256", String(JWT_SECRET))
    .update(`customer-photo:${customerId}:${version}`)
    .digest("base64url")
    .slice(0, SIGNATURE_LENGTH);
}

export function customerPhotoUrl(origin: string, customerId: number, version: number): string {
  return `${origin}/api/customers/${customerId}/photo?v=${version}&sig=${signature(customerId, version)}`;
}

export function isValidCustomerPhotoSignature(customerId: number, version: number, sig: unknown): boolean {
  if (typeof sig !== "string" || sig.length !== SIGNATURE_LENGTH) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(signature(customerId, version)));
}

/**
 * The bytes and type of a stored photo, which is either a data URI
 * ("data:image/jpeg;base64,...") or raw base64 with its type kept beside it.
 */
export function decodeStoredPhoto(stored: string, fallbackMimeType: string): { body: Buffer; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,/.exec(stored);
  const base64 = match ? stored.slice(match[0].length) : stored;
  const body = Buffer.from(base64, "base64");
  if (body.length === 0) return null;
  return { body, mimeType: match ? match[1] : fallbackMimeType };
}
