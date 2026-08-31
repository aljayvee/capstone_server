import { z } from "zod";

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
] as const;

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
});

export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;
