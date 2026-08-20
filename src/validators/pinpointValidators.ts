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
});

export const pinpointsBodySchema = z.object({
  pinpoints: z
    .array(pinpointSchema)
    .min(1, "At least one pinpoint is required.")
    .max(3, "Maximum 3 pinpoints allowed per errand."),
});

export type PinpointInput = z.infer<typeof pinpointSchema>;
export type PinpointsInput = z.infer<typeof pinpointsBodySchema>;
