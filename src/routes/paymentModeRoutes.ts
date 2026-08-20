import { Router } from "express";
import { listPaymentModes } from "../controllers/paymentModeController.js";
import { authenticateToken } from "../middleware/auth.js";
import { readLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// GET /api/payment-modes - All 4 modes with their current Active/Inactive
// status, so clients know which are selectable without hardcoding IDs.
router.get("/", authenticateToken, readLimiter, listPaymentModes);

export default router;
