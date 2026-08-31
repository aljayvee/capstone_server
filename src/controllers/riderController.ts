import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import * as userService from "../services/userService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";
import { parseOrThrow } from "../validators/validate.js";
import { pushTokenSchema } from "../validators/pushTokenValidators.js";
import { riderPhotoUploadSchema } from "../validators/riderPhotoValidators.js";
import { riderBeaconSchema } from "../validators/riderBeaconValidators.js";
import * as riderBeaconService from "../services/riderBeaconService.js";

function parseRiderId(raw: string): number {
  const riderId = parseInt(raw, 10);
  if (isNaN(riderId)) {
    throw new ServiceError(400, "Invalid rider ID");
  }
  return riderId;
}

/** A RIDER may only reach their own record. OWNER/DISPATCHER may read any. */
function assertSelfIfRider(req: AuthenticatedRequest, riderId: number) {
  const callerRole = String(req.user?.role || "").toUpperCase();
  if (callerRole === "RIDER" && req.user?.id !== riderId) {
    throw new ServiceError(403, "Access denied: Riders can only view their own profile.");
  }
}

/** Nobody but the account holder, whatever their role. */
function assertSelf(req: AuthenticatedRequest, riderId: number) {
  if (req.user?.id !== riderId) {
    throw new ServiceError(403, "Access denied: You can only change your own profile.");
  }
}

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
  const riderId = parseRiderId(req.params.riderId);
  assertSelfIfRider(req, riderId);

  const rider = await userService.getRiderProfile(riderId);
  res.status(200).json({ user: rider, rider });
});

// GET /api/riders/:riderId/photo - the avatar bytes, as a base64 data URI
export const getRiderPhoto = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const riderId = parseRiderId(req.params.riderId);
  assertSelfIfRider(req, riderId);
  const photo = await userService.getRiderPhoto(riderId);
  res.status(200).json(photo);
});

// PUT /api/riders/:riderId/photo - set or replace the avatar
export const uploadRiderPhoto = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const riderId = parseRiderId(req.params.riderId);
  // Stricter than the read rule on purpose: a dispatcher may look at a rider's
  // profile, but nobody edits someone else's face.
  assertSelf(req, riderId);
  const input = parseOrThrow(riderPhotoUploadSchema, req.body);
  const result = await userService.uploadRiderPhoto(riderId, input);
  res.status(200).json(result);
});

// DELETE /api/riders/:riderId/photo - back to initials
export const deleteRiderPhoto = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const riderId = parseRiderId(req.params.riderId);
  assertSelf(req, riderId);
  const result = await userService.deleteRiderPhoto(riderId);
  res.status(200).json(result);
});

// POST /api/riders/beacon - the rider's low-rate presence beacon.
//
// Always the caller's own id, never a path parameter: a beacon is a claim about
// where YOU are, and letting one account post another's position would let any
// rider hand themselves the nearest-rider ranking.
export const recordBeacon = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(riderBeaconSchema, req.body);
  const result = await riderBeaconService.recordBeacon(req.user!.id, input);
  // Echoing the derived state lets the device show the rider exactly why they
  // are not receiving offers — a missing permission is something only they can fix.
  res.status(200).json(result);
});

// POST /api/riders/push-token - Rider registers/updates their Expo push token
export const registerPushToken = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(pushTokenSchema, req.body);
  await userService.registerPushToken(req.user!.id, input);
  res.json({ success: true });
});
