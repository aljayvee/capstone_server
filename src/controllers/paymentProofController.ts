import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ServiceError } from "../services/ServiceError.js";
import { parseOrThrow } from "../validators/validate.js";
import { paymentProofUploadSchema } from "../validators/paymentProofValidators.js";
import * as paymentProofService from "../services/paymentProofService.js";
import * as errandService from "../services/errandService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

/**
 * POST /api/errands/:id/payment-proof — the customer uploads what they sent.
 *
 * Refused since 2026-10-08 with where to go instead: the whole bill is paid at
 * the door and the rider photographs the transfer (paymentProofService). The
 * route stays so installed apps get that sentence rather than a 404.
 */
export const uploadPaymentProof = asyncHandler<AuthenticatedRequest>(async (req) => {
  const input = parseOrThrow(paymentProofUploadSchema, req.body);
  await paymentProofService.uploadPaymentProof(req.params.id, req.user!.id, input);
});

/** GET /api/errands/:id/payment-proof — what was read, for either party. */
export const getPaymentProof = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const errand = await errandService.getErrandById(req.params.id);
  if (!errand) throw new ServiceError(404, "Errand not found");

  const role = String(req.user?.role || "").toUpperCase();
  if (role === "CUSTOMER" && errand.customerId !== req.user?.id) {
    throw new ServiceError(403, "Access denied: this isn't your errand.");
  }
  if (role === "RIDER" && errand.riderId !== req.user?.id) {
    throw new ServiceError(403, "Access denied: this errand isn't assigned to you.");
  }

  res.json({ success: true, proof: await paymentProofService.getPaymentProof(req.params.id) });
});
