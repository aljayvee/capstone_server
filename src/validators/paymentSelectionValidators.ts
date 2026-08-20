import { z } from "zod";

export const createPaymentSelectionSchema = z.object({
  paymentModeId: z.coerce.number().int().positive("paymentModeId is required."),
});

export type CreatePaymentSelectionInput = z.infer<typeof createPaymentSelectionSchema>;
