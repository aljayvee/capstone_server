import { z } from "zod";
import { POPULAR_SORTS } from "../lib/places/storeRanking.js";
import { GOOGLE_PLACE_ID } from "../lib/places/googlePlacesClient.js";
import { CLOSE_TIME, OPEN_TIME } from "../lib/places/storeHours.js";

/** One day of a store's week (lib/places/storeHours.ts). Open days need both times. */
const dayHoursSchema = z
  .object({
    day: z.number().int().min(0).max(6),
    closed: z.boolean(),
    open: z.string(),
    close: z.string(),
  })
  .refine((d) => d.closed || (OPEN_TIME.test(d.open) && CLOSE_TIME.test(d.close)), {
    message: "Opening and closing times are written HH:MM, 24-hour.",
  });

/** A store's week: all seven days, each once. */
export const weeklyHoursSchema = z
  .object({ days: z.array(dayHoursSchema).length(7, "Give all seven days.") })
  .refine((w) => new Set(w.days.map((d) => d.day)).size === 7, { message: "Each day of the week once." });

export const placeCreateSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(150, "Name cannot exceed 150 characters"),
  categoryId: z.number().int().positive("Category ID must be a positive integer"),
  address: z.string().min(3, "Address must be at least 3 characters").max(255, "Address cannot exceed 255 characters"),
  barangay: z.string().max(80, "Barangay cannot exceed 80 characters").nullable().optional(),
  latitude: z.number().min(-90).max(90, "Latitude must be between -90 and 90"),
  longitude: z.number().min(-180).max(180, "Longitude must be between -180 and 180"),
  keywords: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
  /** The Google Maps place this store is. A new store must have one (placeService.createPlace). */
  googlePlaceId: z.string().regex(GOOGLE_PLACE_ID, "That is not a Google Maps place.").nullable().optional(),
  /** Google Maps does not list the store; the owner pinned it on the map (placeService.checkOwnerPin). */
  ownerPinned: z.boolean().optional(),
  openingHours: weeklyHoursSchema.nullable().optional(),
  /** The owner says a store that looks like a registered one is another branch. */
  confirmDuplicate: z.boolean().optional(),
});

export const placeUpdateSchema = placeCreateSchema.partial();

/** The owner's storefront photo for a Location Store: the category picture's rules (2MB, JPEG/PNG/WebP). */
export { storeCategoryImageUploadSchema as placePhotoUploadSchema } from "./merchantCategoryValidators.js";

/** The Archive's Restore selected: up to 200 retired stores at once. */
export const placeRestoreSchema = z.object({
  ids: z.array(z.string().min(1).max(36)).min(1, "Choose at least one store.").max(200),
});

/** The owner portal's search of Google Maps for stores to register: words, or a category's kinds of shop. */
export const googleDirectorySearchSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    categoryId: z.coerce.number().int().positive().optional(),
  })
  .refine((v) => (v.q && v.q.length >= 2) || v.categoryId !== undefined, {
    message: "Type at least 2 letters or choose a category.",
  });

/** A spot a dispatcher is about to pin a store at. */
export const storeLocationCheckSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

/**
 * The customer's store search (GET /api/places/establishments). Both
 * coordinates or neither: one alone is not a place to search near.
 */
/**
 * The Home tab's "Popular Stores": where the customer is, and whether to include
 * photos. The Popular Stores screen also pages (`offset`, `limit`) and sorts.
 */
export const popularEstablishmentsSchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    photos: z.enum(["1", "true"]).optional(),
    categoryId: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(20).optional(),
    sort: z.enum(POPULAR_SORTS).optional(),
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
    /** Only this merchant category's stores (Home's category tiles). */
    categoryId: z.coerce.number().int().positive().optional(),
    /** The nearby list a page at a time (the "Stores near you" screen). */
    offset: z.coerce.number().int().min(0).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(20).optional(),
    /** "1": the nearby list with the featured brands first ("Find stores", 2026-10-14). */
    featured: z.enum(["1", "true"]).optional(),
  })
  .refine((query) => (query.lat === undefined) === (query.lng === undefined), {
    message: "lat and lng go together.",
  });
