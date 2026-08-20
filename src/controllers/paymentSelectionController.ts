import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ServiceError } from "../services/ServiceError.js";
import { parseOrThrow } from "../validators/validate.js";
import { createPaymentSelectionSchema } from "../validators/paymentSelectionValidators.js";
import * as paymentSelectionService from "../services/paymentSelectionService.js";
import * as errandService from "../services/errandService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export const getPaymentSelection = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const errand = await errandService.getErrandById(req.params.id);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  // IDOR check, matching errandController.getErrandById's pattern — only the
  // errand's own customer or assigned rider (or Owner/Dispatcher) can view it.
  const callerRole = String(req.user?.role || "").toUpperCase();
  const callerId = req.user?.id;
  if (callerRole === "CUSTOMER" && errand.customerId !== callerId) {
    throw new ServiceError(403, "Access denied: You can only view your own errand's payment selection.");
  }
  if (callerRole === "RIDER" && errand.riderId !== callerId) {
    throw new ServiceError(403, "Access denied: You can only view payment selections for errands assigned to you.");
  }

  const selection = await paymentSelectionService.getPaymentSelection(req.params.id);
  res.json(selection);
});

export const confirmPaymentSelection = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(createPaymentSelectionSchema, req.body);
  const selection = await paymentSelectionService.confirmPaymentSelection(req.params.id, req.user!.id, input);
  res.status(201).json(selection);
});
