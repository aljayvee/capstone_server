import { z } from "zod";

export const placeCreateSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name cannot exceed 150 characters"),
  categoryId: z.number().int().positive("Category ID must be a positive integer"),
  address: z.string().min(3, "Address must be at least 3 characters").max(255, "Address cannot exceed 255 characters"),
  barangay: z.string().max(80, "Barangay cannot exceed 80 characters").nullable().optional(),
  latitude: z.number().min(-90).max(90, "Latitude must be between -90 and 90"),
  longitude: z.number().min(-180).max(180, "Longitude must be between -180 and 180"),
  keywords: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

export const placeUpdateSchema = placeCreateSchema.partial();

/** A spot a dispatcher is about to pin a store at. */
export const storeLocationCheckSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

/**
 * The customer's store search (GET /api/places/establishments). Both
 * coordinates or neither: one alone is not a place to search near.
 */
/** The Home tab's "Popular Stores": where the customer is, and whether to include photos. */
export const popularEstablishmentsSchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    photos: z.enum(["1", "true"]).optional(),
  })
  .refine((query) => (query.lat === undefined) === (query.lng === undefined), {
    message: "lat and lng go together.",
  });

export const establishmentSearchSchema = z
  .object({
    q: z.string().trim().max(80, "Search is at most 80 characters.").optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    /** "1": include each shop's photo address (the Home row). Each is a billed lookup. */
    photos: z.enum(["1", "true"]).optional(),
  })
  .refine((query) => (query.lat === undefined) === (query.lng === undefined), {
    message: "lat and lng go together.",
  });
