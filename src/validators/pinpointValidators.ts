import { z } from "zod";

export const pinpointSchema = z.object({
  storeName: z.string().trim().min(1, "Store name is required.").max(60, "Store name must be at most 60 characters."),
  latitude: z.coerce
    .number()
    .min(-90, "Latitude must be a number between -90 and 90.")
    .max(90, "Latitude must be a number between -90 and 90."),
  longitude: z.coerce
    .number()
    .min(-180, "Longitude must be a number between -180 and 180.")
    .max(180, "Longitude must be a number between -180 and 180."),

  // Which catalogue entry this stop is, when the dispatcher picked one rather
  // than dropping a bare pin. Both were absent from this schema, and zod strips
  // unknown keys — so even a client that sent them had them silently discarded,
  // and no pinpoint in the database has ever carried either.
  //
  // They are not decoration. categoryId selects the per-category dwell allowance
  // the ETA is built from (without it every stop falls back to the generic
  // 20-minute estimate in etaService), and placeId is what lets the server tell
  // that a rider settled at a different branch of the same chain.
  //
  // Optional because a pin dropped on a store outside the catalogue genuinely
  // has neither, and that must keep working.
  placeId: z.string().trim().max(36).optional().nullable(),
  categoryId: z.coerce.number().int().positive().optional().nullable(),
});

export const pinpointsBodySchema = z.object({
  pinpoints: z
    .array(pinpointSchema)
    .min(1, "At least one pinpoint is required.")
    .max(3, "Maximum 3 pinpoints allowed per errand.")
    // The same catalogue place twice is provably one shop, and it used to be
    // accepted silently and then billed as two. Refused here rather than only
    // in the browser, because a client guard does nothing for a request that
    // does not come from our dispatcher screen.
    //
    // Only the PROVABLE case. Two pins that are merely near each other are left
    // alone on purpose: two real shops can share a building, the dispatcher
    // screen already warns at 40 m and lets them override it deliberately, and
    // the fee side refuses to double-charge for anything provably identical
    // (see distinctStopCount).
    .superRefine((pinpoints, ctx) => {
      const seen = new Map<string, number>();
      pinpoints.forEach((pin, index) => {
        const placeId = pin.placeId?.trim();
        if (!placeId) return;
        const firstIndex = seen.get(placeId);
        if (firstIndex === undefined) {
          seen.set(placeId, index);
          return;
        }
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "placeId"],
          message: `"${pin.storeName}" is already pinned as stop ${firstIndex + 1}.`,
        });
      });
    }),
});

export type PinpointInput = z.infer<typeof pinpointSchema>;
export type PinpointsInput = z.infer<typeof pinpointsBodySchema>;
