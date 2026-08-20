import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";
import * as trackingService from "../services/trackingService.js";
import { parseOrThrow } from "../validators/validate.js";
import { trackBatchSchema } from "../validators/trackingValidators.js";

// POST /api/errands/:id/track — rider uploads a batch of GPS fixes, including
// everything buffered while offline. Ownership and status are enforced in the
// service, alongside the quality gate.
export const uploadTrackBatch = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const riderId = req.user?.id;
  if (!riderId) throw new ServiceError(401, "Authentication required.");

  const { points } = parseOrThrow(trackBatchSchema, req.body);
  const result = await trackingService.ingestBatch(req.params.id, riderId, points);

  // Reporting what was dropped and why lets the device surface a real problem
  // (a permanently inaccurate sensor, a wrong clock) instead of silently
  // uploading points that never land.
  res.status(200).json(result);
});

// GET /api/errands/:id/track — breadcrumb replay for dispute resolution.
// Staff only: this is a person's movement history, not errand metadata.
export const getTrack = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const points = await trackingService.listTrack(req.params.id);
  res.status(200).json({ errandId: req.params.id, points });
});
