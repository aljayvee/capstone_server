import { Router } from "express";
import {
  listMerchantCategories,
  createMerchantCategory,
  updateMerchantCategory,
} from "../controllers/merchantCategoryController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { readLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

router.get("/", authenticateToken, readLimiter, listMerchantCategories);
router.post("/", authenticateToken, requireRole(["OWNER"]), userApiLimiter, createMerchantCategory);
router.put("/:id", authenticateToken, requireRole(["OWNER"]), userApiLimiter, updateMerchantCategory);

export default router;
