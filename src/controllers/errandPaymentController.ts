import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ServiceError } from "../services/ServiceError.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  confirmUpfrontSchema,
  confirmTopUpSchema,
  confirmBalanceSchema,
  recordRefundSchema,
} from "../validators/errandPaymentValidators.js";
import * as errandPaymentService from "../services/errandPaymentService.js";
import * as errandService from "../services/errandService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

/**
 * GET /api/errands/:id/payments
 *
 * Readable by everyone with a stake in the errand. The customer needs to see
 * what they still owe — without it, a dispatcher's "please send the balance"
 * arrives with no figure the customer can check it against — and the rider needs
 * the amount to collect at the door.
 *
 * Same IDOR shape as paymentSelectionController.getPaymentSelection.
 */
export const getPaymentLedger = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const errand = await errandService.getErrandById(req.params.id);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  const callerRole = String(req.user?.role || "").toUpperCase();
  const callerId = req.user?.id;
  if (callerRole === "CUSTOMER" && errand.customerId !== callerId) {
    throw new ServiceError(403, "Access denied: this isn't your errand.");
  }
  if (callerRole === "RIDER" && errand.riderId !== callerId) {
    throw new ServiceError(403, "Access denied: this errand isn't assigned to you.");
  }

  const ledger = await errandPaymentService.getPaymentLedger(req.params.id);
  res.json({ success: true, ledger });
});

/**
 * POST /api/errands/:id/payments/request-half
 *
 * The rider, holding every item, asks for the customer's 50% before heading to
 * them. Rider-only at the route; the service checks it is THEIR errand.
 */
export const requestHalfPayment = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const result = await errandPaymentService.requestHalfPayment(req.params.id, req.user!.id);
  res.json({ success: true, ...result });
});

export const confirmUpfrontPayment = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(confirmUpfrontSchema, req.body);
  const ledger = await errandPaymentService.confirmUpfrontPayment(req.params.id, req.user!.id, input);
  res.json({ success: true, ledger });
});

export const confirmTopUp = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(confirmTopUpSchema, req.body);
  const ledger = await errandPaymentService.confirmTopUp(req.params.id, req.user!.id, input);
  res.json({ success: true, ledger });
});

export const confirmBalancePayment = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(confirmBalanceSchema, req.body);
  const ledger = await errandPaymentService.confirmBalancePayment(req.params.id, req.user!.id, input);
  res.json({ success: true, ledger });
});

export const recordRefund = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(recordRefundSchema, req.body);
  const ledger = await errandPaymentService.recordRefund(req.params.id, req.user!.id, input);
  res.json({ success: true, ledger });
});
