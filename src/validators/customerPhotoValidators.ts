import { z } from "zod";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png"] as const;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export const customerPhotoUploadSchema = z.object({
  photoData: z
    .string()
    .min(1, "Photo data is required")
    .refine(
      (data) => {
        // Accepts base64 data URI or raw base64 string
        return (
          data.startsWith("data:image/jpeg;base64,") ||
          data.startsWith("data:image/jpg;base64,") ||
          data.startsWith("data:image/png;base64,") ||
          data.length > 50
        );
      },
      { message: "Invalid image format. Only JPEG, JPG, and PNG are supported." }
    ),
  mimeType: z.enum(ALLOWED_MIME_TYPES, {
    message: "Invalid file type. Only JPEG, JPG, and PNG images are allowed.",
  }),
  fileSize: z
    .number()
    .int("File size must be an integer in bytes")
    .positive("File size must be positive")
    .max(MAX_FILE_SIZE_BYTES, "Image file exceeds the 5MB maximum size limit."),
  fileName: z.string().max(255).optional(),
});

export type CustomerPhotoUploadInput = z.infer<typeof customerPhotoUploadSchema>;
