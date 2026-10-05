import { z } from "zod";

/**
 * An optional free-text detail a customer may clear again.
 *
 * Three different requests have to stay distinguishable: omitted (undefined)
 * means "leave the stored value alone", which is what the one-tap "Set as
 * default" sends; blank or null means "the customer emptied this box", stored
 * as null rather than an empty string; anything else is trimmed and kept.
 */
export function optionalDetail(max: number, label: string) {
  return z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .nullish()
    .transform((value) => (value === undefined ? undefined : value || null));
}

export const STREET_NAME_MAX = 150;
export const LANDMARK_MAX = 200;
export const DELIVERY_NOTES_MAX = 300;

export const locationSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Label is required and must be 1–30 characters.")
    .max(30, "Label is required and must be 1–30 characters."),
  address: z.string().trim().min(1, "Address is required."),
  streetName: optionalDetail(STREET_NAME_MAX, "Street name"),
  landmark: optionalDetail(LANDMARK_MAX, "Landmark"),
  notes: optionalDetail(DELIVERY_NOTES_MAX, "Notes"),
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
