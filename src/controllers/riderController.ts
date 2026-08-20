import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import * as userService from "../services/userService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";
import { parseOrThrow } from "../validators/validate.js";
import { pushTokenSchema } from "../validators/pushTokenValidators.js";

export const listOnlineRiders = asyncHandler(async (req, res) => {
  const riders = await userService.listOnlineRiders();
  res.json({ success: true, riders });
});

// Full fleet roster (all statuses, real active-order counts) — backs dispatcher/owner
// rider-monitoring views.
export const listAllRiders = asyncHandler(async (req, res) => {
  const riders = await userService.listAllRiders();
  res.json({ success: true, riders });
});

export const getRiderProfile = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) {
    throw new ServiceError(400, "Invalid rider ID");
  }

  const callerRole = String(req.user?.role || "").toUpperCase();
  const callerId = req.user?.id;
  // IDOR Check: Rider accounts can ONLY access their own profile. OWNER/DISPATCHER can view any rider.
  if (callerRole === "RIDER" && callerId !== riderId) {
    throw new ServiceError(403, "Access denied: Riders can only view their own profile.");
  }

  const rider = await userService.getRiderProfile(riderId);
  res.status(200).json({ user: rider, rider });
});

// POST /api/riders/push-token - Rider registers/updates their Expo push token
export const registerPushToken = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(pushTokenSchema, req.body);
  await userService.registerPushToken(req.user!.id, input);
  res.json({ success: true });
});
