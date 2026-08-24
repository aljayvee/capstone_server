import { Router } from "express";
import {
  listMerchantCategories,
  createMerchantCategory,
  updateMerchantCategory,
  getStoreCategoryImage,
  uploadStoreCategoryImage,
  deleteStoreCategoryImage,
} from "../controllers/merchantCategoryController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { readLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

router.get("/", authenticateToken, readLimiter, listMerchantCategories);
router.post("/", authenticateToken, requireRole(["OWNER"]), userApiLimiter, createMerchantCategory);
router.put("/:id", authenticateToken, requireRole(["OWNER"]), userApiLimiter, updateMerchantCategory);

// Category hero image (`store_cat_image`). The GET is open to any signed-in
// role because the CustomerApp Bento grid and the dispatcher store picker both
// render it; only the OWNER may set or clear it, matching the rest of this
// resource. Reads use readLimiter rather than userApiLimiter - a customer app
// cold start fetches one per active category in quick succession.
router.get("/:id/image", authenticateToken, readLimiter, getStoreCategoryImage);
router.put("/:id/image", authenticateToken, requireRole(["OWNER"]), userApiLimiter, uploadStoreCategoryImage);
router.delete("/:id/image", authenticateToken, requireRole(["OWNER"]), userApiLimiter, deleteStoreCategoryImage);

export default router;
