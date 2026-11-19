import { Router } from "express";
import {
  searchItems,
  getPlaceItems,
  matchEstablishment,
  catalogueItem,
  retireItem,
} from "../controllers/catalogController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { readLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// Item autocomplete search (Stage 3 item placement and customer suggestions)
// Read-only, no price exposure.
router.get("/search", authenticateToken, readLimiter, searchItems);

// Menu items for a specific verified establishment
router.get("/places/:placeId/items", authenticateToken, readLimiter, getPlaceItems);

// Staff cataloguing: save an item against a store, or take one out of the
// helper. Staff only; the helper's reads stay open to customers.
router.post("/items", authenticateToken, requireRole(["DISPATCHER", "OWNER"]), userApiLimiter, catalogueItem);
router.delete("/items/:id", authenticateToken, requireRole(["DISPATCHER", "OWNER"]), userApiLimiter, retireItem);

// Location-aware establishment categorizer and MerchantCategory matcher
// Requires staff role (OWNER or DISPATCHER)
router.post(
  "/match-establishment",
  authenticateToken,
  requireRole(["DISPATCHER", "OWNER"]),
  userApiLimiter,
  matchEstablishment
);

export default router;
