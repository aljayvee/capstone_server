import { Router } from "express";
import {
  inferItemCategories,
  inferStoreCategory,
  suggestItemPlacements,
} from "../controllers/categoryInferenceController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

/**
 * Category guessing, for the dispatcher console's stages 2 and 3.
 *
 * Staff only. A customer has no use for it, and the endpoint is a thin proxy in
 * front of a sidecar with no authentication of its own — the API server being
 * the only thing that can reach that sidecar is most of what keeps it safe, so
 * the door in front of it is narrow on purpose.
 *
 * userApiLimiter rather than readLimiter: these are POSTs that each cost a model
 * evaluation, and stage 3 can batch a hundred items into one of them.
 */
router.post(
  "/store",
  authenticateToken,
  requireRole(["DISPATCHER", "OWNER"]),
  userApiLimiter,
  inferStoreCategory
);

router.post(
  "/items",
  authenticateToken,
  requireRole(["DISPATCHER", "OWNER"]),
  userApiLimiter,
  inferItemCategories
);

/**
 * Placement for one errand's items. Errand-scoped because the answer names one
 * of THAT errand's pinned shops, not just a category.
 */
router.post(
  "/errands/:errandId/item-placements",
  authenticateToken,
  requireRole(["DISPATCHER", "OWNER"]),
  userApiLimiter,
  suggestItemPlacements
);

export default router;
