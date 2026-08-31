import { Router } from "express";
import {
  listOnlineRiders,
  listAllRiders,
  getRiderProfile,
  registerPushToken,
  getRiderPhoto,
  uploadRiderPhoto,
  deleteRiderPhoto,
  recordBeacon,
} from "../controllers/riderController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { readLimiter, userApiLimiter, trackingLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// GET /api/riders - Full fleet roster, all statuses (Dispatcher/Owner monitoring views)
router.get("/", authenticateToken, requireRole(["OWNER", "DISPATCHER"]), readLimiter, listAllRiders);

// GET /api/riders/online - Fetch active online riders
router.get("/online", authenticateToken, readLimiter, listOnlineRiders);

// GET /api/riders/profile/:riderId - Strict IDOR-protected rider profile lookup
router.get("/profile/:riderId", authenticateToken, readLimiter, getRiderProfile);

// POST /api/riders/push-token - Rider registers/updates their Expo push token
router.post("/push-token", authenticateToken, requireRole(["RIDER"]), userApiLimiter, registerPushToken);

// POST /api/riders/beacon - presence + position, independent of any errand.
//
// trackingLimiter rather than userApiLimiter: this fires every 30s per rider all
// shift, which is telemetry cadence, not user-action cadence.
router.post("/beacon", authenticateToken, requireRole(["RIDER"]), trackingLimiter, recordBeacon);

// Rider avatar. Mirrors the customer photo routes (customerRoutes.ts) — same 5MB
// jpeg/jpg/png limits, same dedicated-table storage, same base64 data URI on the
// wire. Kept off /users so the rider app has one namespace for everything it owns.
router.get("/:riderId/photo", authenticateToken, readLimiter, getRiderPhoto);
router.put("/:riderId/photo", authenticateToken, userApiLimiter, uploadRiderPhoto);
router.delete("/:riderId/photo", authenticateToken, userApiLimiter, deleteRiderPhoto);

// NOTE: live rider GPS position is NOT served from this backend — it streams
// through Firebase Realtime Database (see AGENTS.md server section 5), matching
// the documented hybrid architecture and the pattern already used by chat
// (DispatcherChatPanel.tsx) and CustomerApp. A prior in-process store/socket-event
// implementation here was removed in favor of that.

export default router;
