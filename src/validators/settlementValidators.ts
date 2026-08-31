import { z } from "zod";

export const submitSettlementSchema = z.object({
  // The default path sends this and nothing else. The amount due is a figure
  // the server already holds, so the client is not asked for it — a rider app
  // that could name its own collected amount is a rider app that can
  // under-report, and no amount of UI discipline closes that.
  collectedInFull: z.literal(true).optional(),

  // The exception. A customer who paid short has no other source for the
  // figure, so it is typed — and recorded as a SHORT settlement with a reason,
  // which is what makes it reviewable rather than silent.
  collectedAmount: z.coerce
    .number()
    .nonnegative("collectedAmount must be zero or positive.")
    .optional(),
  shortReason: z.string().trim().min(1).max(300).optional(),
});

export type SubmitSettlementInput = z.infer<typeof submitSettlementSchema>;
