import { z } from "zod";

/**
 * Inputs for the category guesser.
 *
 * Bounded lengths rather than open strings: these values reach a Python process
 * that builds character n-grams over them, and an unbounded name would be a
 * cheap way to make that process do a lot of pointless work. The caps are far
 * above any real shop name or item.
 */

export const inferStoreCategorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "A store name is required.")
    .max(200, "Store name must be at most 200 characters."),
  // Google Places `types` for this result, when the console has them. Optional
  // because most Tacurong shops are pinned from the catalogue or straight off
  // the map, where there is no Google result behind the pin at all.
  googleTypes: z.array(z.string().trim().max(60)).max(30).optional(),
});

export type InferStoreCategoryInput = z.infer<typeof inferStoreCategorySchema>;

export const inferItemCategoriesSchema = z.object({
  // Capped at the same 100 the Python service accepts. A basket larger than
  // that is not a real errand, and the cap keeps one request from becoming a
  // hundred model evaluations.
  names: z
    .array(z.string().trim().min(1).max(200))
    .min(1, "At least one item is required.")
    .max(100, "At most 100 items can be categorised at once."),
});

export type InferItemCategoriesInput = z.infer<typeof inferItemCategoriesSchema>;

/**
 * Stage 3's "where does this go?" question.
 *
 * Takes the errand so the answer can name one of ITS pinned shops rather than
 * a bare category — the same item lands on a different pin every order.
 */
export const suggestItemPlacementsSchema = z.object({
  names: z
    .array(z.string().trim().min(1).max(200))
    .min(1, "At least one item is required.")
    .max(100, "At most 100 items can be placed at once."),
});

export type SuggestItemPlacementsInput = z.infer<typeof suggestItemPlacementsSchema>;
