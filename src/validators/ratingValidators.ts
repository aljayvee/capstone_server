import { z } from "zod";

export const createRatingSchema = z.object({
  stars: z.coerce.number().int().min(1, "Rating must be between 1 and 5 stars.").max(5, "Rating must be between 1 and 5 stars."),
  comment: z.string().trim().max(500, "Comment must be at most 500 characters.").optional(),
});

export type CreateRatingInput = z.infer<typeof createRatingSchema>;
