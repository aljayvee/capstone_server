import { z } from "zod";

// Same allowlist and ceiling as customerPhotoValidators. The rider app downscales
// to 1600px / q0.8 before upload, which puts a real receipt at 280-410KB — the
// 5MB cap is a backstop against an un-downscaled original (your samples were
// 10-13MB) rather than an expected size.
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png"] as const;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export const PROOF_IMAGE_KINDS = ["RECEIPT", "TRANSFER", "PROOF_OF_DELIVERY"] as const;

export const proofImageUploadSchema = z.object({
  kind: z.enum(PROOF_IMAGE_KINDS),

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
    .int("File size must be an integer in bytes")
    .positive("File size must be positive")
    .max(MAX_FILE_SIZE_BYTES, "Image exceeds the 5MB maximum. Downscale before uploading."),

  // Which stop this came from. Absent for a delivery photo, which happens at the
  // customer's address rather than at any store.
  pinpointId: z.coerce.number().int().positive().optional().nullable(),

  // For TRANSFER images the device has already read the text with ML Kit, so the
  // server persists that rather than spending a Vision call on a screenshot that
  // on-device OCR handles perfectly well. Absent for RECEIPT, which the server
  // reads itself.
  deviceText: z.string().max(20000).optional().nullable(),
});

export const proofImageConfirmSchema = z.object({
  confirmedTotal: z.coerce
    .number()
    .nonnegative("A confirmed total cannot be negative.")
    .max(1_000_000, "That total looks implausible — please re-check the receipt."),
});

export type ProofImageUploadInput = z.infer<typeof proofImageUploadSchema>;
export type ProofImageConfirmInput = z.infer<typeof proofImageConfirmSchema>;
