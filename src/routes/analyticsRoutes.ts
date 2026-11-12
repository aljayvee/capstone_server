import { Router } from "express";
import { getDashboard } from "../controllers/analyticsController.js";
import { authenticateToken, requireRole, requirePermission } from "../middleware/auth.js";
import { readLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// GET /api/analytics/dashboard?frequency=TODAY|WEEK|MONTH|YEAR - Owner-only
// real-time operations summary (rider status, errand status, revenue, trend).
router.get("/dashboard", authenticateToken, requireRole(["OWNER"]), requirePermission("dashboard.view"), readLimiter, getDashboard);

export default router;
