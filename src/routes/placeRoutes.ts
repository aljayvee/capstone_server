import { Router } from "express";
import { placeController } from "../controllers/placeController.js";
import { checkStoreLocationHandler } from "../controllers/storeLocationController.js";
import { popularEstablishmentsHandler, searchEstablishmentsHandler } from "../controllers/establishmentController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
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

// GET /api/places/establishments/popular?lat=&lng=&photos=1 - the customer app's
// Home "Popular Stores": Google's most popular shops nearby, best rated first.
// The same limiter as the store search: each call is a billed Google request.
router.get(
  "/establishments/popular",
  authenticateToken,
  requireRole(["CUSTOMER", "DISPATCHER", "OWNER"]),
  establishmentSearchLimiter,
  popularEstablishmentsHandler
);

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

// POST /api/places - create a verified place (Owner only)
router.post("/", authenticateToken, requireRole(["OWNER"]), userApiLimiter, (req, res) =>
  placeController.create(req, res)
);

// PUT /api/places/:id - update a verified place (Owner only)
router.put("/:id", authenticateToken, requireRole(["OWNER"]), userApiLimiter, (req, res) =>
  placeController.update(req, res)
);

// DELETE /api/places/:id - remove a verified place (Owner only)
router.delete("/:id", authenticateToken, requireRole(["OWNER"]), userApiLimiter, (req, res) =>
  placeController.delete(req, res)
);

export default router;
