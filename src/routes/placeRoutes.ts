import { Router } from "express";
import { placeController } from "../controllers/placeController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { readLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

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

// GET /api/places/:id - single place detail
router.get("/:id", authenticateToken, readLimiter, (req, res) => placeController.getById(req, res));

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
