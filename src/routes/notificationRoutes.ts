import { Router } from "express";
import { listNotifications, markNotificationRead } from "../controllers/notificationController.js";
import { authenticateToken } from "../middleware/auth.js";
import { readLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// Every authenticated role (owner/dispatcher/rider/customer) can list their
// own notifications — scoping to "their own" happens in notificationService.ts,
// not via requireRole (customers aren't a RoleType, matching how every other
// customer-facing route already works — see errandRoutes.ts's POST /errands).
router.get("/", authenticateToken, readLimiter, listNotifications);
router.patch("/:id/read", authenticateToken, userApiLimiter, markNotificationRead);

export default router;
