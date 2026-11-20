import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { assertDispatcherMayRead } from "../lib/errandReadAccess.js";
import { errandRepository } from "../repositories/errandRepository.js";
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
//
// The trail is never easier to read than the errand: an unknown id is a 404
// (it used to answer 200 with an empty trail), and a dispatcher gets the same
// claim check as GET /api/errands/:id.
export const getTrack = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const errand = await errandRepository.findById(req.params.id);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  assertDispatcherMayRead(errand, { id: req.user?.id, role: req.user?.role });

  res.status(200).json(await trackingService.getReplay(req.params.id, errand));
});
