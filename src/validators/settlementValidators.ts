import { z } from "zod";

export const submitSettlementSchema = z.object({
  collectedAmount: z.coerce.number().nonnegative("collectedAmount must be zero or positive."),
});

export type SubmitSettlementInput = z.infer<typeof submitSettlementSchema>;
