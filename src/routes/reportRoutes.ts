import { Router } from "express";
import {
  getSalesReport,
  getRiderPerformanceReport,
  getCommissionReport,
  getSettlementReport,
  getTransactionSummary,
  getExceptionReport,
  exportReportPdf,
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

// Errands that did not reconcile, across the period — including the ones already
// cleared, and by whom. Owner-only like every report above it.
router.get("/exceptions", authenticateToken, requireRole(["OWNER"]), readLimiter, getExceptionReport);

// Any of the six above, rendered as a PDF in the standard Sugo report format.
//
// Registered LAST so the literal paths win: a parameterised route declared
// earlier would swallow "/sales" and answer every report with a PDF.
//
// Same middleware as its siblings, deliberately. A PDF export is a read of data
// this caller can already fetch as JSON, so a stricter limiter here would only
// be theatre — and readLimiter still bounds how fast documents can be pulled.
router.get("/:reportType/pdf", authenticateToken, requireRole(["OWNER"]), readLimiter, exportReportPdf);

export default router;
