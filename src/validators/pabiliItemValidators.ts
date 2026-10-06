import { z } from "zod";

// "5 kg", "1.5 L", "10 pcs": how big one of the item is, kept apart from its
// name (schema.prisma PabiliDetail.size). Blank means no size, so a dispatcher
// clearing the field stores null rather than an empty string. Absent (undefined)
// is different from null on a PATCH: pabiliDetailRepository.replaceForErrand
// keeps the stored size for a row that omits the field, because a client built
// before this column existed would otherwise wipe every size on its first save.
export const itemSizeSchema = z
  .string()
  .trim()
  .max(40, "Size must be at most 40 characters.")
  .nullable()
  .optional()
  .transform((value) => (value === "" ? null : value));

// What the customer asked the rider to mind about one item ("paki pili yung
// walang bulok"). Same blank-is-null and absent-is-kept rules as size.
export const itemNotesSchema = z
  .string()
  .trim()
  .max(200, "Item notes must be at most 200 characters.")
  .nullable()
  .optional()
  .transform((value) => (value === "" ? null : value));

export const pabiliItemSchema = z.object({
  itemName: z.string().trim().min(1, "Item name is required.").max(120, "Item name must be at most 120 characters."),
  storeCategory: z.string().trim().max(100, "Store category must be at most 100 characters.").optional(),
  quantity: z.coerce.number().int().positive("quantity must be a positive integer."),
  size: itemSizeSchema,
  notes: itemNotesSchema,
});

export const pabiliItemsBodySchema = z.object({
  items: z.array(pabiliItemSchema).min(1, "At least one item is required.").max(50, "Too many items."),
});

export type PabiliItemInput = z.infer<typeof pabiliItemSchema>;
export type PabiliItemsInput = z.infer<typeof pabiliItemsBodySchema>;
