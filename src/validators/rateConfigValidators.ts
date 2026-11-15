import { z } from "zod";
import { HANDLING_AMOUNT_THRESHOLD } from "../services/patterns/pricingStrategy.js";
import { RATE_CONFIG_BOUNDS } from "../lib/rateConfigBounds.js";

function boundedPeso(label: string, bound: { min: number; max: number }) {
  return z.coerce
    .number()
    .finite(`${label} must be a valid number.`)
    .min(bound.min, `${label} must be at least ₱${bound.min.toLocaleString()}.`)
    .max(bound.max, `${label} cannot exceed ₱${bound.max.toLocaleString()}.`);
}

/**
 * The owner's rate card, as submitted.
 *
 * Every rate field is bounded by `RATE_CONFIG_BOUNDS` (preventing ₱0
 * undercutting on rider-paid base/distance rates and million-peso spikes), and
 * the two cross-field rules preserve the meaning of threshold pairs.
 */
export const updateRateConfigSchema = z
  .object({
    baseFee: boundedPeso("Base Delivery Fare", RATE_CONFIG_BOUNDS.baseFee),
    perKmRate: boundedPeso("Excess Distance Rate", RATE_CONFIG_BOUNDS.perKmRate),
    multiStoreFeePerStore: boundedPeso(
      "Multi-Store Stop Fee",
      RATE_CONFIG_BOUNDS.multiStoreFeePerStore
    ),
    maxAdditionalStores: z.coerce
      .number()
      .finite("Max Additional Stores must be a valid number.")
      .int("Max Additional Stores must be a whole number.")
      .min(
        RATE_CONFIG_BOUNDS.maxAdditionalStores.min,
        `Max Additional Stores must be at least ${RATE_CONFIG_BOUNDS.maxAdditionalStores.min}.`
      )
      .max(
        RATE_CONFIG_BOUNDS.maxAdditionalStores.max,
        `Max Additional Stores cannot exceed ${RATE_CONFIG_BOUNDS.maxAdditionalStores.max}.`
      ),
    groceryFeeThreshold: z.coerce
      .number()
      .finite("Grocery Order Threshold must be a valid number.")
      .nonnegative("Grocery Order Threshold cannot be negative.")
      .max(
        RATE_CONFIG_BOUNDS.groceryFeeThreshold.max,
        `Grocery Order Threshold cannot exceed ₱${RATE_CONFIG_BOUNDS.groceryFeeThreshold.max.toLocaleString()}.`
      ),
    groceryFeePercent: z.coerce
      .number()
      .finite("Grocery Percentage Rate must be a valid number.")
      .min(
        RATE_CONFIG_BOUNDS.groceryFeePercent.min,
        `Grocery Percentage Rate must be at least ${RATE_CONFIG_BOUNDS.groceryFeePercent.min}%.`
      )
      .max(
        RATE_CONFIG_BOUNDS.groceryFeePercent.max,
        `Grocery Percentage Rate cannot exceed ${RATE_CONFIG_BOUNDS.groceryFeePercent.max}%.`
      ),
    groceryFeeFlat: boundedPeso("Grocery Flat Handling Fee", RATE_CONFIG_BOUNDS.groceryFeeFlat),
    nonCodThreshold: boundedPeso("Non-COD Purchase Threshold", RATE_CONFIG_BOUNDS.nonCodThreshold),
    nonCodFeeHigh: boundedPeso("Non-COD High Surcharge", RATE_CONFIG_BOUNDS.nonCodFeeHigh),
    nonCodFeeLow: boundedPeso("Non-COD Low Surcharge", RATE_CONFIG_BOUNDS.nonCodFeeLow),
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
