import { z } from "zod";

export const pabiliItemSchema = z.object({
  itemName: z.string().trim().min(1, "Item name is required.").max(120, "Item name must be at most 120 characters."),
  storeCategory: z.string().trim().max(100, "Store category must be at most 100 characters.").optional(),
  quantity: z.coerce.number().int().positive("quantity must be a positive integer."),
});

export const pabiliItemsBodySchema = z.object({
  items: z.array(pabiliItemSchema).min(1, "At least one item is required.").max(50, "Too many items."),
});

export type PabiliItemInput = z.infer<typeof pabiliItemSchema>;
export type PabiliItemsInput = z.infer<typeof pabiliItemsBodySchema>;
