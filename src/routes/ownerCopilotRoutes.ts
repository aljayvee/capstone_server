import { Router } from "express";
import { copilotChatHandler } from "../controllers/ownerCopilotController.js";
import { authenticateToken, requireRole, requirePermission } from "../middleware/auth.js";
import { ownerCopilotLimiter } from "../middleware/rateLimiters.js";

const router = Router();

/**
 * Executive AI Companion ("Kuya Sugo") endpoint for Owner & Admin roles.
 * POST /api/owner/copilot/chat
 */
router.post(
  "/chat",
  authenticateToken,
  requireRole(["OWNER", "ADMIN"]),
  requirePermission("copilot.use"),
  ownerCopilotLimiter,
  copilotChatHandler
);

export default router;
