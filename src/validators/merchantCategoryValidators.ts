import { z } from "zod";

export const createMerchantCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required.").max(100, "Category name must be at most 100 characters."),
  description: z.string().trim().max(300, "Description must be at most 300 characters.").optional(),
});

export type CreateMerchantCategoryInput = z.infer<typeof createMerchantCategorySchema>;

// How the purchase handling fee is charged for stops of this kind. The AMOUNTS
// stay in RateConfig — only the mode is per-category, so the flat figure and the
// percentage are still edited in one place.
export const HANDLING_FEE_MODES = ["THRESHOLD", "FLAT", "PERCENT", "NONE"] as const;

export const updateMerchantCategorySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(300).optional(),
  status: z.enum(["Active", "Inactive"]).optional(),
  handlingFeeMode: z.enum(HANDLING_FEE_MODES).optional(),

  // How close the rider must get before a stop of this kind counts as reached.
  //
  // Bounded because a radius outside this band cannot do its job: under 25 m no
  // GPS fix is accurate enough to prove the rider is inside, and over 500 m the
  // circle swallows the neighbouring shops the geofence exists to tell apart —
  // downtown Tacurong has stores 25-110 m from each other.
  geofenceRadiusMeters: z.coerce
    .number()
    .int()
    .min(25, "Arrival radius must be at least 25 metres.")
    .max(500, "Arrival radius must be at most 500 metres.")
    .optional(),
});

export type UpdateMerchantCategoryInput = z.infer<typeof updateMerchantCategorySchema>;

// Store category hero image (`store_cat_image`). The cap is deliberately far
// below the 5MB allowed for customer profile photos: this image is pulled by
// every CustomerApp client that renders the Bento grid, often over mobile data
// in Tacurong, so it is capped at 2MB and the owner portal downscales to
// 1200px before it ever reaches here. WebP is allowed alongside JPEG/PNG
// because it is what the browser canvas encoder reaches for first.
const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"] as const;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB

export const storeCategoryImageUploadSchema = z.object({
  imageData: z
    .string()
    .min(1, "Image data is required.")
    .refine((data) => data.startsWith("data:image/"), {
      message: "Image must be a base64 data URI (data:image/...;base64,...).",
    })
    // A base64 payload is ~4/3 the size of the bytes it encodes. Rejecting an
    // oversized string here keeps a 10MB body from reaching the LongText column
    // even when the client lies about `fileSize`.
    .refine((data) => data.length <= Math.ceil(MAX_IMAGE_BYTES * 1.4), {
      message: "Image exceeds the 2MB maximum size limit.",
    }),
  mimeType: z.enum(ALLOWED_IMAGE_MIME_TYPES, {
    message: "Invalid file type. Only JPEG, PNG, and WebP images are allowed.",
  }),
  fileSize: z
    .number()
    .int("File size must be an integer in bytes.")
    .positive("File size must be positive.")
    .max(MAX_IMAGE_BYTES, "Image exceeds the 2MB maximum size limit."),
  fileName: z.string().trim().max(255).optional(),
});

export type StoreCategoryImageUploadInput = z.infer<typeof storeCategoryImageUploadSchema>;
