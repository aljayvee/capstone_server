import { z } from "zod";
import { HANDLING_AMOUNT_THRESHOLD } from "../services/patterns/pricingStrategy.js";

/**
 * The owner's rate card, as submitted.
 *
 * Per-field bounds were all this had, which let any single typo through as long
 * as it was a non-negative number — and a rate card is not a set of independent
 * numbers. Two of the cross-field rules below exist because the relationship
 * they enforce is the whole meaning of the pair: which side of a threshold each
 * fee governs is not something a form can be trusted to get right unaided.
 */
export const updateRateConfigSchema = z
  .object({
    baseFee: z.coerce.number().nonnegative(),
    perKmRate: z.coerce.number().nonnegative(),
    multiStoreFeePerStore: z.coerce.number().nonnegative(),
    maxAdditionalStores: z.coerce.number().int().nonnegative(),
    groceryFeeThreshold: z.coerce.number().nonnegative(),
    groceryFeePercent: z.coerce.number().min(0).max(100),
    groceryFeeFlat: z.coerce.number().nonnegative(),
    nonCodThreshold: z.coerce.number().nonnegative(),
    nonCodFeeHigh: z.coerce.number().nonnegative(),
    nonCodFeeLow: z.coerce.number().nonnegative(),
  })
  // The fee at or above the threshold cannot be the cheaper one.
  //
  // These two columns are named for WHERE they apply, not for their size, so
  // nothing about the field names stops them being filled in the wrong order —
  // and a form with no labels for them at all (the owner portal had none until
  // recently) makes an inversion invisible. A larger purchase paying a smaller
  // handling charge is not a price anyone would choose deliberately.
  .refine((v) => v.nonCodFeeHigh >= v.nonCodFeeLow, {
    path: ["nonCodFeeHigh"],
    message:
      "The non-COD fee at or above the threshold cannot be lower than the fee below it. Check the two amounts are the right way round.",
  })
  // A crossover below the size gate makes the flat tier unreachable.
  //
  // Nothing is charged for handling at all until the basket clears
  // HANDLING_AMOUNT_THRESHOLD (or the list is long enough). Setting the
  // percentage crossover below that point means every basket that qualifies is
  // already past it, the flat fee never applies to anything, and the owner has
  // silently deleted a tier they can still see on screen.
  .refine((v) => v.groceryFeeThreshold >= HANDLING_AMOUNT_THRESHOLD, {
    path: ["groceryFeeThreshold"],
    message: `The order threshold must be at least ₱${HANDLING_AMOUNT_THRESHOLD}. Below that, no basket ever pays the flat fee — the percentage would apply to every order that qualifies.`,
  });

export type UpdateRateConfigInput = z.infer<typeof updateRateConfigSchema>;
