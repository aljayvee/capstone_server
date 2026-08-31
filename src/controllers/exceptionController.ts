import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { resolveExceptionSchema } from "../validators/exceptionValidators.js";
import * as exceptionService from "../services/exceptionService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

/**
 * The dispatcher's working queue: what is still open, right now.
 *
 * Scoped to ALL open exceptions rather than only errands this dispatcher
 * claimed. The claim rule exists to stop two dispatchers working one queue; it
 * is not a reason to hide a shortfall from whoever is actually on shift.
 */
export const getOpenExceptions = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  // A fortnight back by default — long enough that nothing quietly ages out of
  // view over a weekend, short enough that the queue stays a working list.
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  res.json(await exceptionService.findExceptions(start, end, { openOnly: true }));
});

/** Records that a person considered an exception, and what they concluded. */
export const resolveException = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const input = parseOrThrow(resolveExceptionSchema, req.body);

  const review = await exceptionService.resolveException({
    errandId: req.params.id,
    kind: input.kind,
    reviewerId: req.user!.id,
    reason: input.reason,
    amountAtRisk: input.amountAtRisk,
  });

  res.status(201).json(review);
});
