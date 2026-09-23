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
 * Customer-only. A rider or dispatcher uploading a customer's payment proof
 * would be attesting to their own evidence, which is the thing the ledger's
 * confirmedBy field exists to prevent.
 */
export const uploadPaymentProof = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(paymentProofUploadSchema, req.body);
  const { image: proof, autoConfirmed, reviewReason } = await paymentProofService.uploadPaymentProof(
    req.params.id,
    req.user!.id,
    input
  );

  // The bytes never come back. The customer has the original on their phone and
  // the dispatcher reads it through the proof-image endpoint.
  res.json({
    success: true,
    // True when the receipt settled the half-payment on its own. False means a
    // dispatcher will look at it; reviewReason says why, for the app's wording.
    autoConfirmed,
    reviewReason,
    proof: {
      id: proof.id,
      capturedAt: proof.capturedAt,
      referenceNo: proof.extraction?.referenceNo ?? null,
      transactionId: proof.extraction?.transactionId ?? null,
      amount: proof.extraction?.extractedTotal ?? null,
      transactionDate: proof.extraction?.extractedDate ?? null,
    },
  });
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
