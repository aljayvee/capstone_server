import { Router } from "express";
import {
  searchItems,
  getPlaceItems,
  matchEstablishment,
} from "../controllers/catalogController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { readLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// Item autocomplete search (Stage 3 item placement and customer suggestions)
// Read-only, no price exposure.
router.get("/search", authenticateToken, readLimiter, searchItems);

// Menu items for a specific verified establishment
router.get("/places/:placeId/items", authenticateToken, readLimiter, getPlaceItems);

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
