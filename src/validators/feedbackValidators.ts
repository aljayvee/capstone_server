import { z } from "zod";

export const feedbackCategorySchema = z.enum([
  "BUG_REPORT",
  "FEATURE_REQUEST",
  "DELIVERY_EXPERIENCE",
  "APP_USABILITY",
  "OTHER",
]);

export const createFeedbackSchema = z.object({
  category: feedbackCategorySchema.default("OTHER"),
  rating: z.coerce.number().int().min(1, "Rating must be between 1 and 5").max(5, "Rating must be between 1 and 5").default(5),
  subject: z
    .string()
    .trim()
    .min(3, "Subject must be at least 3 characters.")
    .max(120, "Subject cannot exceed 120 characters."),
  message: z
    .string()
    .trim()
    .min(5, "Please provide at least 5 characters of feedback.")
    .max(2000, "Feedback description cannot exceed 2000 characters."),
  contactEmail: z.string().trim().email("Please provide a valid email address.").optional().nullable(),
  contactPhone: z.string().trim().optional().nullable(),
  appVersion: z.string().trim().optional().nullable(),
  platform: z.string().trim().optional().nullable(),
  deviceModel: z.string().trim().optional().nullable(),
  osVersion: z.string().trim().optional().nullable(),
});

export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;

export const resolveFeedbackSchema = z.object({
  developerNotes: z.string().trim().min(2, "Please provide resolution notes."),
  status: z.enum(["IN_REVIEW", "ACKNOWLEDGED", "RESOLVED", "ARCHIVED"]).default("RESOLVED"),
});

export type ResolveFeedbackInput = z.infer<typeof resolveFeedbackSchema>;
