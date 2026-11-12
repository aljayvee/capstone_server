import { z } from "zod";

// One Review screen's flagged lines. Twenty is GEMMA_BATCH_SIZE in the
// sidecar, so a request is one model call, never several queued behind each
// other. A sentence can include several products and notes; each extracted
// product still has the existing 120-character name limit.
export const itemTidyBodySchema = z.object({
  lines: z
    .array(
      z.object({
        id: z.string().trim().min(1, "Each line needs an id.").max(40, "Line id must be at most 40 characters."),
        text: z.string().trim().min(1, "Each line needs text.").max(500, "Item text must be at most 500 characters."),
      })
    )
    .min(1, "Send at least one line.")
    .max(20, "Send at most 20 lines at a time."),
});

export type ItemTidyInput = z.infer<typeof itemTidyBodySchema>;

// One store's typed items, asked "which kind of store sells this?" while the
// customer adds them. Twenty matches the editor's batch.
export const itemStoreCheckBodySchema = z.object({
  names: z
    .array(z.string().trim().min(1, "Item names cannot be blank.").max(120, "Item name must be at most 120 characters."))
    .min(1, "Send at least one item.")
    .max(20, "Send at most 20 items at a time."),
});
