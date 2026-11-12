import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  recordSettlementAdjustmentSchema,
  submitSettlementSchema,
} from "../validators/settlementValidators.js";
import * as settlementService from "../services/settlementService.js";
import * as settlementAdjustmentService from "../services/settlementAdjustmentService.js";
import { ServiceError } from "../services/ServiceError.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export const submitSettlement = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(submitSettlementSchema, req.body);
  const settlement = await settlementService.submitSettlement(req.params.id, req.user!.id, input);
  res.status(201).json(settlement);
});

/** Help Desk "Money still owed": every short handover with something still owed. */
export const listMoneyStillOwed = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  res.json(await settlementAdjustmentService.listMoneyStillOwed(req.user!.id));
});

/** Records money that came in (or was written off) after a short handover. */
export const recordSettlementAdjustment = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(recordSettlementAdjustmentSchema, req.body);
  const result = await settlementAdjustmentService.recordAdjustment({
    errandId: req.params.id,
    kind: input.kind,
    amount: input.amount,
    reference: input.reference,
    note: input.note,
    userId: req.user!.id,
  });
  res.status(201).json(result);
});

/** Undoes one, if the caller recorded it within the last 10 minutes. */
export const voidSettlementAdjustment = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const adjustmentId = Number(req.params.adjustmentId);
  if (!Number.isInteger(adjustmentId) || adjustmentId <= 0) {
    throw new ServiceError(400, "That payment record id is not valid.");
  }
  await settlementAdjustmentService.voidAdjustment(req.params.id, adjustmentId, req.user!.id);
  res.status(204).end();
});
