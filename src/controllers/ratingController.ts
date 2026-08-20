import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ServiceError } from "../services/ServiceError.js";
import { parseOrThrow } from "../validators/validate.js";
import { createRatingSchema } from "../validators/ratingValidators.js";
import * as ratingService from "../services/ratingService.js";
import * as errandService from "../services/errandService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export const getRating = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const errand = await errandService.getErrandById(req.params.id);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  // IDOR check, matching errandController.getErrandById's pattern — only the
  // errand's own customer or assigned rider (or Owner/Dispatcher) can view it.
  const callerRole = String(req.user?.role || "").toUpperCase();
  const callerId = req.user?.id;
  if (callerRole === "CUSTOMER" && errand.customerId !== callerId) {
    throw new ServiceError(403, "Access denied: You can only view your own errand's rating.");
  }
  if (callerRole === "RIDER" && errand.riderId !== callerId) {
    throw new ServiceError(403, "Access denied: You can only view ratings for errands assigned to you.");
  }

  const rating = await ratingService.getRating(req.params.id);
  res.json(rating);
});

export const submitRating = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(createRatingSchema, req.body);
  const rating = await ratingService.submitRating(req.params.id, req.user!.id, input);
  res.status(201).json(rating);
});
