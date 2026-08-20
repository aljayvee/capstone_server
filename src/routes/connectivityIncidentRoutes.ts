import { Router } from "express";
import { openIncident, resolveIncident } from "../controllers/connectivityIncidentController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// Rider-only audit trail: opened the moment the device's NetInfo listener
// reports disconnected, resolved when it reports connected again — see
// useConnectivity.ts in RiderMobileApp.
router.post("/", authenticateToken, requireRole(["RIDER"]), userApiLimiter, openIncident);
router.patch("/:id/resolve", authenticateToken, requireRole(["RIDER"]), userApiLimiter, resolveIncident);

export default router;
