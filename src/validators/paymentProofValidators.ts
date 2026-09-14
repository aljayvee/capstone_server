import { z } from "zod";

/**
 * A customer's payment confirmation screenshot.
 *
 * Same allowlist and ceiling as proofImageValidators — one upload contract for
 * every image this system accepts, so a size or type rule cannot be tightened in
 * one place and forgotten in the other.
 *
 * Deliberately has no `amount` or `reference` field. Those come from the image
 * itself, read by Cloud Vision: a client-supplied figure alongside a picture is
 * an invitation to type one number and upload another.
 */
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png"] as const;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export const paymentProofUploadSchema = z.object({
  imageData: z
    .string()
    .min(1, "Image data is required.")
    .refine(
      (data) =>
        data.startsWith("data:image/jpeg;base64,") ||
        data.startsWith("data:image/jpg;base64,") ||
        data.startsWith("data:image/png;base64,") ||
        data.length > 50,
      { message: "Invalid image format. Only JPEG, JPG, and PNG are supported." }
    ),

  mimeType: z.enum(ALLOWED_MIME_TYPES, {
    message: "Invalid file type. Only JPEG, JPG, and PNG images are allowed.",
  }),

  fileSize: z
    .number()
    .int()
    .positive()
    .max(MAX_FILE_SIZE_BYTES, "That image is too large. Please use one under 5MB."),
});

export type PaymentProofUploadInput = z.infer<typeof paymentProofUploadSchema>;
