import { z } from "zod";
import type { ExceptionKind } from "../services/patterns/exceptionRules.js";

/**
 * Kinds a reviewer may clear.
 *
 * Mirrors ExceptionKind in patterns/exceptionRules.ts. Listed here rather than
 * imported so an unknown string from a client is rejected at the edge, before it
 * reaches a row that is meant to stand as evidence.
 */
export const EXCEPTION_KINDS = [
  "CASH_VARIANCE",
  "RECEIPT_DIVERGENCE",
  "UNVERIFIED_PURCHASE",
  "WRONG_BRANCH",
  "MISSING_RECEIPT",
  "STALLED_STOP",
  // Both left out until 2026-10-15, so "Resolve" on either row answered 400.
  // A written reason is the only way left to clear them: since the downpayment
  // was retired on 2026-10-08 nothing raises or clears an overage, and the
  // portal has no screen that records a balance paid after delivery. The
  // reason model was trained with reasons for both (OVERAGE_*, BALANCE_*).
  "OVERAGE_PENDING",
  "UNPAID_BALANCE",
  // Has to be clearable, or it would sit in the queue for good once someone
  // decided what to do with the goods.
  "CANCELLED_AFTER_PURCHASE",
] as const;

/**
 * Fails to compile when exceptionRules gains a kind the list above lacks. The
 * queue offers "Resolve" on every row, so a kind missing here is a button that
 * can only ever fail.
 */
type MustBeNever<T extends never> = T;
export type EveryKindIsClearable = MustBeNever<Exclude<ExceptionKind, (typeof EXCEPTION_KINDS)[number]>>;

export const resolveExceptionSchema = z.object({
  kind: z.enum(EXCEPTION_KINDS),

  // Required, and required to say something. An exception cleared with an empty
  // reason is weak evidence later, which is exactly when it is needed.
  reason: z
    .string()
    .trim()
    .min(3, "Say why this is being cleared.")
    .max(500, "Keep the reason under 500 characters."),

  // The exposure as the reviewer saw it. Frozen on the row because the figures
  // behind a derived exception can move afterwards.
  amountAtRisk: z.coerce.number().nonnegative().max(1_000_000).default(0),

  // CASH_VARIANCE on a short only: what happened to the money. NOT_PAID_YET
  // records the decision alone and leaves the whole short owed.
  cashOutcome: z
    .object({
      kind: z.enum(["RIDER_PAID_BACK", "CUSTOMER_PAID_GCASH", "WRITTEN_OFF", "NOT_PAID_YET"]),
      amount: z.coerce.number().nonnegative().max(1_000_000).optional(),
      reference: z.string().trim().max(40, "Keep the reference under 40 characters.").nullish(),
    })
    .nullish(),
});

export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;

/**
 * Asking for a suggested reason. Every kind the queue can show may ask for
 * one, which is now the same list as the kinds that can be cleared.
 */
export const reasonSuggestionQuerySchema = z.object({
  kind: z.enum(EXCEPTION_KINDS),
  // Which row, when an errand has two exceptions of one kind.
  occurredAt: z.coerce.date().optional(),
});
