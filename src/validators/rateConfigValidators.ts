import { z } from "zod";

export const updateRateConfigSchema = z.object({
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
});

export type UpdateRateConfigInput = z.infer<typeof updateRateConfigSchema>;
