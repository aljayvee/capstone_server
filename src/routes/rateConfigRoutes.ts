import { Router } from "express";
import { getRateConfig, updateRateConfig } from "../controllers/rateConfigController.js";
import { authenticateToken, requireRole, requirePermission } from "../middleware/auth.js";
import { readLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

router.get("/", authenticateToken, readLimiter, getRateConfig);
router.put("/", authenticateToken, requireRole(["OWNER"]), requirePermission("rates.manage"), userApiLimiter, updateRateConfig);

export default router;
