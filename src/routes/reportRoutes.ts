import { Router } from "express";
import {
  getSalesReport,
  getRiderPerformanceReport,
  getCommissionReport,
  getSettlementReport,
  getTransactionSummary,
} from "../controllers/reportController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { readLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// All report endpoints are Owner-only (NFR Sec-10: "only Admin/Owner can access
// all reports including sales, commission, and rider performance"). Every route
// accepts ?period=DAILY|WEEKLY|MONTHLY|YEARLY&date=YYYY-MM-DD (date defaults to now).
router.get("/sales", authenticateToken, requireRole(["OWNER"]), readLimiter, getSalesReport);
router.get("/rider-performance", authenticateToken, requireRole(["OWNER"]), readLimiter, getRiderPerformanceReport);
router.get("/commission", authenticateToken, requireRole(["OWNER"]), readLimiter, getCommissionReport);
router.get("/settlement", authenticateToken, requireRole(["OWNER"]), readLimiter, getSettlementReport);
router.get("/transactions", authenticateToken, requireRole(["OWNER"]), readLimiter, getTransactionSummary);

export default router;
