import { z } from "zod";

export const createMerchantCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required.").max(100, "Category name must be at most 100 characters."),
  description: z.string().trim().max(300, "Description must be at most 300 characters.").optional(),
});

export type CreateMerchantCategoryInput = z.infer<typeof createMerchantCategorySchema>;

export const updateMerchantCategorySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(300).optional(),
  status: z.enum(["Active", "Inactive"]).optional(),
});

export type UpdateMerchantCategoryInput = z.infer<typeof updateMerchantCategorySchema>;
