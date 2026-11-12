import { Response } from "express";
import * as settlementAdjustmentService from "../services/settlementAdjustmentService.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { resolveExceptionSchema, reasonSuggestionQuerySchema } from "../validators/exceptionValidators.js";
import * as exceptionService from "../services/exceptionService.js";
import * as exceptionReasonService from "../services/exceptionReasonService.js";
import { getDispatcherAiSuggestionsEnabled } from "../services/sysAdminDevOpsService.js";
import { ServiceError } from "../services/ServiceError.js";
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
  const outcome = input.cashOutcome;

  if (outcome && outcome.kind !== "NOT_PAID_YET") {
    if (input.kind !== "CASH_VARIANCE") {
      throw new ServiceError(400, "Money can only be recorded against a cash short.");
    }
    // The decision and the money, saved together.
    const review = await settlementAdjustmentService.resolveCashShort({
      errandId: req.params.id,
      reviewerId: req.user!.id,
      reason: input.reason,
      amountAtRisk: input.amountAtRisk,
      outcome: { kind: outcome.kind, amount: outcome.amount ?? 0, reference: outcome.reference },
    });
    res.status(201).json(review);
    return;
  }

  const review = await exceptionService.resolveException({
    errandId: req.params.id,
    kind: input.kind,
    reviewerId: req.user!.id,
    reason: input.reason,
    amountAtRisk: input.amountAtRisk,
  });

  res.status(201).json(review);
});

/**
 * The model's suggested reason for clearing one exception. Suggests only: the
 * record is written by resolveException, from whatever the person submits.
 */
export const suggestExceptionReason = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  // The sysadmin's switch, enforced here too: hiding the button alone would
  // leave the model one direct request away while it is meant to be off.
  if (!getDispatcherAiSuggestionsEnabled()) {
    throw new ServiceError(403, "AI suggestions are turned off by the system administrator.");
  }
  const query = parseOrThrow(reasonSuggestionQuerySchema, req.query);
  res.json(await exceptionReasonService.suggestExceptionReason(req.params.id, query.kind, query.occurredAt));
});
