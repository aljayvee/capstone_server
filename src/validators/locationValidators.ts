import { z } from "zod";

export const locationSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Label is required and must be 1–30 characters.")
    .max(30, "Label is required and must be 1–30 characters."),
  address: z.string().trim().min(1, "Address is required."),
  latitude: z.coerce
    .number()
    .min(-90, "Latitude must be a number between -90 and 90.")
    .max(90, "Latitude must be a number between -90 and 90."),
  longitude: z.coerce
    .number()
    .min(-180, "Longitude must be a number between -180 and 180.")
    .max(180, "Longitude must be a number between -180 and 180."),
  isDefault: z.boolean().optional(),
});
export type LocationInput = z.infer<typeof locationSchema>;
