import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { declineErrandReviewSchema } from "../validators/errandDeclineValidators.js";
import * as errandService from "../services/errandService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";
import { parseOrThrow } from "../validators/validate.js";
import { createErrandSchema, assignRiderSchema, declineErrandSchema, errandQuoteSchema } from "../validators/errandValidators.js";
import { pinpointsBodySchema } from "../validators/pinpointValidators.js";
import { pabiliItemsBodySchema } from "../validators/pabiliItemValidators.js";
import { occurredAtSchema } from "../validators/trackingValidators.js";
import { proofImageUploadSchema, proofImageConfirmSchema } from "../validators/proofImageValidators.js";
import * as proofImageService from "../services/proofImageService.js";

export const listErrands = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const callerRole = String(req.user?.role || "").toUpperCase();
  const errands = await errandService.listErrands({ id: req.user!.id, role: callerRole });
  res.json(errands);
});

export const getErrandById = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const errand = await errandService.getErrandById(req.params.id);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  // IDOR check: customers can only see their own errands; riders can only see errands assigned to them
  const callerRole = String(req.user?.role || "").toUpperCase();
  const callerId = req.user?.id;
  if (callerRole === "CUSTOMER" && errand.customerId !== callerId) {
    throw new ServiceError(403, "Access denied: You can only view your own errands.");
  }
  if (callerRole === "RIDER" && errand.riderId !== callerId) {
    throw new ServiceError(403, "Access denied: You can only view errands assigned to you.");
  }

  // IDOR check: dispatchers can only see unclaimed (AVAILABLE) errands, or errands they claimed
  if (callerRole === "DISPATCHER" && callerId) {
    const latestLog = (errand as any).dispatchLogs?.[0];
    const isAvailable = String(errand.status).toUpperCase() === "AVAILABLE";
    if (!isAvailable && latestLog && latestLog.dispatcherId !== callerId) {
      const claimant = latestLog.dispatcher
        ? `${latestLog.dispatcher.firstName} ${latestLog.dispatcher.lastName}`.trim()
        : "another dispatcher";
      throw new ServiceError(403, `Access denied: This errand is currently assigned to ${claimant}.`);
    }
  }

  res.json(errand);
});

export const listErrandsForUser = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) {
    throw new ServiceError(400, "Invalid user ID");
  }

  // IDOR check: customers can only query their own errand history
  const callerRole = String(req.user?.role || "").toUpperCase();
  const callerId = req.user?.id;
  if (callerRole === "CUSTOMER" && callerId !== userId) {
    throw new ServiceError(403, "Access denied: You can only view your own errand history.");
  }

  const errands = await errandService.listErrandsForCustomer(userId);
  res.json(errands);
});

export const listErrandsForRider = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) {
    throw new ServiceError(400, "Invalid rider ID");
  }

  // IDOR check: riders can only query their own assigned errands
  const callerRole = String(req.user?.role || "").toUpperCase();
  const callerId = req.user?.id;
  if (callerRole === "RIDER" && callerId !== riderId) {
    throw new ServiceError(403, "Access denied: You can only view errands assigned to you.");
  }

  const errands = await errandService.listErrandsForRider(riderId);
  res.json(errands);
});

export const createErrand = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(createErrandSchema, req.body);
  const errand = await errandService.createErrand(req.user!.id, input);
  res.status(201).json(errand);
});

// Prices a draft before it is created, so the customer's checkout shows a figure
// the server produced rather than one it computed itself. Writes nothing.
export const quoteErrand = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(errandQuoteSchema, req.body);
  res.json(await errandService.quoteErrand(input));
});

export const claimErrand = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const errand = await errandService.claimErrand(req.params.id, req.user!.id);
  res.json(errand);
});

export const acceptErrand = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  // occurredAt is set by a rider flushing an action they took while offline, so
  // the record reflects when it happened rather than when the signal came back.
  const occurredAt = parseOrThrow(occurredAtSchema, req.body?.occurredAt);
  const errand = await errandService.acceptErrand(req.params.id, req.user!.id, occurredAt);
  res.json(errand);
});

export const markItemsPurchased = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const receiptTotal = req.body?.receiptTotal ? parseFloat(String(req.body.receiptTotal)) : undefined;
  const occurredAt = parseOrThrow(occurredAtSchema, req.body?.occurredAt);
  const errand = await errandService.markItemsPurchased(req.params.id, req.user!.id, receiptTotal, occurredAt);
  res.json({ success: true, errand });
});

export const assignRider = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const callerRole = String(req.user?.role || "").toUpperCase();
  if (req.user?.id) {
    await errandService.verifyDispatcherAccess(req.params.id, req.user.id, callerRole);
  }
  const input = parseOrThrow(assignRiderSchema, req.body);
  const errand = await errandService.assignRider(req.params.id, input.riderId);
  res.json({ success: true, errand });
});

export const updateStatus = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const callerRole = String(req.user?.role || "").toUpperCase();
  if (req.user?.id) {
    await errandService.verifyDispatcherAccess(req.params.id, req.user.id, callerRole);
  }
  const occurredAt = parseOrThrow(occurredAtSchema, req.body?.occurredAt);
  const errand = await errandService.updateStatus(
    req.params.id,
    req.body.status,
    { id: req.user!.id, role: callerRole },
    occurredAt
  );
  res.json(errand);
});

export const declineErrand = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(declineErrandSchema, req.body ?? {});
  const errand = await errandService.declineErrand(req.params.id, req.user!.id, input.reason);
  res.json(errand);
});

export const setPinpoints = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const callerRole = String(req.user?.role || "").toUpperCase();
  if (req.user?.id) {
    await errandService.verifyDispatcherAccess(req.params.id, req.user.id, callerRole);
  }
  const input = parseOrThrow(pinpointsBodySchema, req.body);
  const errand = await errandService.savePinpoints(req.params.id, input.pinpoints);
  res.json({ success: true, errand });
});

export const updateItems = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const callerRole = String(req.user?.role || "").toUpperCase();
  if (req.user?.id) {
    await errandService.verifyDispatcherAccess(req.params.id, req.user.id, callerRole);
  }
  const input = parseOrThrow(pabiliItemsBodySchema, req.body);
  const errand = await errandService.updateItems(req.params.id, input.items);
  res.json({ success: true, errand });
});

export const enablePayment = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const callerRole = String(req.user?.role || "").toUpperCase();
  if (req.user?.id) {
    await errandService.verifyDispatcherAccess(req.params.id, req.user.id, callerRole);
  }
  const errand = await errandService.enablePayment(req.params.id, req.user!.id);
  res.json({ success: true, errand });
});

export const confirmOrder = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const errand = await errandService.confirmOrder(req.params.id, req.user!.id);
  res.json({ success: true, errand });
});

// PATCH /api/errands/:id/dispatcher-decline — dispatcher declines during review.
//
// Separate from the rider's POST /:id/decline, which bounces an assignment back
// to the pool. This one ends the errand and requires a reason.
export const declineErrandReview = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const input = parseOrThrow(declineErrandReviewSchema, req.body);
  const result = await errandService.declineErrandReview(
    req.params.id,
    req.user!.id,
    input.reason
  );
  res.json(result);
});

// GET /api/errands/:id/decline-reasons — the recorded reasons, newest first.
export const getDeclineReasons = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const reasons = await errandService.getDeclineReasons(req.params.id);
  res.json(reasons);
});

// Photographic proof for one errand — a store receipt, a transfer confirmation,
// or a handover photo. Receipts are read by Cloud Vision here; transfers arrive
// with text the device already extracted on-device (see proofImageService).
export const uploadProofImage = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(proofImageUploadSchema, req.body);
  const image = await proofImageService.uploadProofImage(req.params.id, req.user!.id, input);

  // The blob goes back out to nobody — the client already holds the picture it
  // just uploaded, and echoing it doubles the response for nothing.
  res.status(201).json({
    id: image.id,
    kind: image.kind,
    clarityVerdict: image.clarityVerdict,
    extraction: {
      id: image.extraction!.id,
      engine: image.extraction!.engine,
      extractedTotal: image.extraction!.extractedTotal,
      extractedDate: image.extraction!.extractedDate,
      status: image.extraction!.status,
    },
  });
});

// The rider accepts the extracted figure or corrects it. Both are kept.
export const confirmProofImage = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(proofImageConfirmSchema, req.body);
  const extraction = await proofImageService.confirmProofImage(
    req.params.id,
    Number(req.params.imageId),
    req.user!.id,
    input.confirmedTotal
  );
  res.json({ success: true, extraction });
});

export const listProofImages = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  res.json(await proofImageService.listProofImages(req.params.id));
});
