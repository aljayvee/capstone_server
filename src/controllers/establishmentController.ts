import { asyncHandler } from "../lib/asyncHandler.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { parseOrThrow } from "../validators/validate.js";
import { establishmentSearchSchema, popularEstablishmentsSchema } from "../validators/placeValidators.js";
import { popularEstablishments, searchEstablishments } from "../services/establishmentService.js";

/**
 * The customer app's "Location" store picker. Without `q`, the shops nearest
 * `lat`/`lng`; with it, Location Stores and Google Places together.
 */
export const searchEstablishmentsHandler = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { q, lat, lng, photos } = parseOrThrow(establishmentSearchSchema, req.query);
  const near = lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : null;
  res.json(await searchEstablishments({ query: q, near, customerId: customerIdOf(req), withPhotos: photos !== undefined }));
});

/**
 * The ranking reads the customer's own past orders. Customers and staff have
 * separate id sequences that overlap, so a staff caller gets none.
 */
function customerIdOf(req: AuthenticatedRequest): number | null {
  const isCustomer = String(req.user?.role ?? "").toUpperCase() === "CUSTOMER";
  return isCustomer && Number.isInteger(Number(req.user?.id)) ? Number(req.user!.id) : null;
}

/** The customer app's Home "Popular Stores": six shops near `lat`/`lng`, best rated first. */
export const popularEstablishmentsHandler = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { lat, lng, photos } = parseOrThrow(popularEstablishmentsSchema, req.query);
  const near = lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : null;
  res.json(await popularEstablishments({ near, customerId: customerIdOf(req), withPhotos: photos !== undefined }));
});
