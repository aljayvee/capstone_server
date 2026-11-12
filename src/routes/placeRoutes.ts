import { Router } from "express";
import { placeController } from "../controllers/placeController.js";
import { checkStoreLocationHandler } from "../controllers/storeLocationController.js";
import { popularEstablishmentsHandler, searchEstablishmentsHandler } from "../controllers/establishmentController.js";
import { authenticateToken, requireRole, requirePermission } from "../middleware/auth.js";
import { establishmentSearchLimiter, readLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// The verified-places catalogue is the Tier-1 POI source the dispatcher pins
// stores from, and those coordinates now feed route distance, fare calculation
// and ETA. Every route here is therefore authenticated, and mutations are
// restricted to OWNER — the owner portal's PlacesDirectoryScreen is the only UI
// that writes to it (see the ["owner"] guard on /places in src/app/routes.tsx).
//
// Reads stay open to any signed-in role: the dispatcher console searches this
// catalogue while claiming an errand. The shared limiters from
// middleware/rateLimiters.ts replace a locally-declared one so places are
// governed by the same budgets as the rest of the API.

// GET /api/places/categories - active merchant categories for the store picker
router.get("/categories", authenticateToken, readLimiter, (req, res) =>
  placeController.getCategories(req, res)
);

// GET /api/places - search the catalogue. `includeInactive=true` is honoured
// only for OWNER/DISPATCHER (enforced in the controller), so retired places
// stay out of every customer-facing path.
router.get("/", authenticateToken, readLimiter, (req, res) => placeController.getAll(req, res));

// GET /api/places/reverse?lat=&lng= - nearest verified place to a coordinate.
// Backs the customer app's address resolution: a pin dropped on a known
// establishment resolves to its catalogue name instead of the plus code the
// device geocoder returns for a coordinate with no street address.
//
// MUST stay above the "/:id" route below — Express matches in declaration order,
// and "/:id" would otherwise capture "reverse" as an id and 404 every call.
router.get("/reverse", authenticateToken, readLimiter, (req, res) =>
  placeController.reverse(req, res)
);

// GET /api/places/establishments?q=&lat=&lng= - the customer app's "Location"
// store picker: Location Stores plus Google Places (services/establishmentService.ts).
// Its own limiter, because each call is a billed Google request. Above "/:id"
// for the same reason as "/reverse".
router.get(
  "/establishments",
  authenticateToken,
  requireRole(["CUSTOMER", "DISPATCHER", "OWNER"]),
  establishmentSearchLimiter,
  searchEstablishmentsHandler
);

// GET /api/places/establishments/popular?lat=&lng=&photos=1&offset=&limit=&sort=
// - the customer app's Home "Popular Stores": Google's most popular shops
// nearby, best rated first, paged up to 20 for the Popular Stores screen.
// The same limiter as the store search: each call is a billed Google request.
router.get(
  "/establishments/popular",
  authenticateToken,
  requireRole(["CUSTOMER", "DISPATCHER", "OWNER"]),
  establishmentSearchLimiter,
  popularEstablishmentsHandler
);

// GET /api/places/google?q= | ?categoryId= - the owner portal's search of
// Google Maps for stores to register (2026-10-13); each result says whether it
// is registered already. Billed Google requests, so the store search's limiter.
router.get("/google", authenticateToken, requireRole(["OWNER"]), requirePermission("merchants.manage"), establishmentSearchLimiter, (req, res) =>
  placeController.googleSearch(req, res)
);

// GET /api/places/google/:googlePlaceId - one Google Maps place to fill the form.
router.get("/google/:googlePlaceId", authenticateToken, requireRole(["OWNER"]), requirePermission("merchants.manage"), establishmentSearchLimiter, (req, res) =>
  placeController.googleDetails(req, res)
);

// GET /api/places/duplicates - active Location Stores that look registered twice.
router.get("/duplicates", authenticateToken, requireRole(["OWNER", "DISPATCHER"]), readLimiter, (req, res) =>
  placeController.duplicates(req, res)
);

// GET /api/places/:id/photo - the owner's storefront photo. No sign-in on
// purpose: the customer app's image loader sends no Authorization header
// (store cards show it), and a storefront is no secret.
router.get("/:id/photo", readLimiter, (req, res) => placeController.getPhoto(req, res));

// GET /api/places/:id - single place detail
router.get("/:id", authenticateToken, readLimiter, (req, res) => placeController.getById(req, res));

// POST /api/places/location-check - may a store be pinned at this spot?
// Staff only: it answers from the service border and the loaded road graph
// (see services/storeLocationGuard.ts), which the console needs and a customer
// does not.
router.post(
  "/location-check",
  authenticateToken,
  requireRole(["DISPATCHER", "OWNER"]),
  userApiLimiter,
  checkStoreLocationHandler
);

// POST /api/places/restore - bring several retired stores back (Owner only).
// Each unlinked one is linked to Google Maps on the way when Google has it.
router.post("/restore", authenticateToken, requireRole(["OWNER"]), requirePermission("merchants.manage"), userApiLimiter, (req, res) =>
  placeController.restore(req, res)
);

// POST /api/places - create a verified place (Owner only)
router.post("/", authenticateToken, requireRole(["OWNER"]), requirePermission("merchants.manage"), userApiLimiter, (req, res) =>
  placeController.create(req, res)
);

// PUT /api/places/:id - update a verified place (Owner only)
router.put("/:id", authenticateToken, requireRole(["OWNER"]), requirePermission("merchants.manage"), userApiLimiter, (req, res) =>
  placeController.update(req, res)
);

// PUT /api/places/:id/photo - set the storefront photo (Owner only)
router.put("/:id/photo", authenticateToken, requireRole(["OWNER"]), requirePermission("merchants.manage"), userApiLimiter, (req, res) =>
  placeController.uploadPhoto(req, res)
);

// DELETE /api/places/:id/photo - remove the storefront photo (Owner only)
router.delete("/:id/photo", authenticateToken, requireRole(["OWNER"]), requirePermission("merchants.manage"), userApiLimiter, (req, res) =>
  placeController.deletePhoto(req, res)
);

// DELETE /api/places/:id - remove a verified place (Owner only)
router.delete("/:id", authenticateToken, requireRole(["OWNER"]), requirePermission("merchants.manage"), userApiLimiter, (req, res) =>
  placeController.delete(req, res)
);

export default router;
