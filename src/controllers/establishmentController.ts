import { asyncHandler } from "../lib/asyncHandler.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { parseOrThrow } from "../validators/validate.js";
import { establishmentSearchSchema, popularEstablishmentsSchema } from "../validators/placeValidators.js";
import { popularEstablishments, searchEstablishments } from "../services/establishmentService.js";
import type { Request } from "express";

/**
 * This API's own address as the phone reached it, for the owner's storefront
 * photo addresses (GET /api/places/:id/photo). HTTPS anywhere but a local
 * machine: Android refuses a plain-HTTP image.
 */
export function publicOrigin(req: Request): string | null {
  const host = req.headers?.host;
  if (!host) return null;
  const local = /^(localhost|127\.|10\.|192\.168\.)/.test(host);
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = local ? forwarded || req.protocol || "http" : "https";
  return `${proto}://${host}`;
}

/**
 * The customer app's "Location" store picker. Without `q`, the shops nearest
 * `lat`/`lng`; with it, Location Stores and Google Places together. With
 * `categoryId`, only that merchant category's stores.
 */
export const searchEstablishmentsHandler = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { q, lat, lng, photos, categoryId, offset, limit, featured } = parseOrThrow(establishmentSearchSchema, req.query);
  const near = lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : null;
  res.json(
    await searchEstablishments({
      query: q,
      near,
      customerId: customerIdOf(req),
      withPhotos: photos !== undefined,
      photoOrigin: publicOrigin(req),
      categoryId,
      offset,
      limit,
      featured: featured !== undefined,
    })
  );
});

/**
 * The ranking reads the customer's own past orders. Customers and staff have
 * separate id sequences that overlap, so a staff caller gets none.
 */
function customerIdOf(req: AuthenticatedRequest): number | null {
  const isCustomer = String(req.user?.role ?? "").toUpperCase() === "CUSTOMER";
  return isCustomer && Number.isInteger(Number(req.user?.id)) ? Number(req.user!.id) : null;
}

/**
 * The customer app's Home "Popular Stores": a page of shops near `lat`/`lng`,
 * best rated first, or in the screen's chosen `sort`.
 */
export const popularEstablishmentsHandler = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { lat, lng, photos, categoryId, offset, limit, sort } = parseOrThrow(popularEstablishmentsSchema, req.query);
  const near = lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : null;
  res.json(
    await popularEstablishments({
      near,
      customerId: customerIdOf(req),
      withPhotos: photos !== undefined,
      photoOrigin: publicOrigin(req),
      categoryId,
      offset,
      limit,
      sort,
    })
  );
});
