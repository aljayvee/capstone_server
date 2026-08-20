import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { submitSettlementSchema } from "../validators/settlementValidators.js";
import * as settlementService from "../services/settlementService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export const submitSettlement = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(submitSettlementSchema, req.body);
  const settlement = await settlementService.submitSettlement(req.params.id, req.user!.id, input.collectedAmount);
  res.status(201).json(settlement);
});
