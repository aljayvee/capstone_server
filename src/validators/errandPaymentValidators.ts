import { z } from "zod";

/**
 * A dispatcher's attestation that money arrived on the Facebook Page.
 *
 * `amount` is required rather than inferred, even though the service already
 * knows what is due. Making the dispatcher type the figure they are looking at
 * is the point: a one-tap "confirm what we expected" would record agreement with
 * a number nobody read, and the service compares the two and refuses a mismatch.
 */
const confirmationBase = {
  amount: z.coerce.number().positive({ message: "Enter the amount that arrived." }),
  note: z.string().trim().max(255).optional(),
};

// The specific photo (the customer's own upload, or a rider's door-side
// RIDER_BALANCE_PROOF) the dispatcher is looking at when confirming — only
// upfront and balance confirmations are ever backed by one of these.
const proofBackedFields = {
  proofImageId: z.coerce.number().int().positive().optional(),
};

export const confirmUpfrontSchema = z.object({ ...confirmationBase, ...proofBackedFields });
export const confirmTopUpSchema = z.object(confirmationBase);
export const confirmBalanceSchema = z.object({ ...confirmationBase, ...proofBackedFields });

export const recordRefundSchema = z.object({
  ...confirmationBase,
  // A refund always has a reason — somebody cancelled something — and the person
  // who has to answer for it later will not remember which.
  note: z
    .string()
    .trim()
    .min(1, { message: "Say why this refund was issued." })
    .max(255),
});

export type ConfirmUpfrontInput = z.infer<typeof confirmUpfrontSchema>;
export type ConfirmTopUpInput = z.infer<typeof confirmTopUpSchema>;
export type ConfirmBalanceInput = z.infer<typeof confirmBalanceSchema>;
export type RecordRefundInput = z.infer<typeof recordRefundSchema>;
