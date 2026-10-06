import { z } from "zod";
import { normalizeItems } from "../lib/category/categoryServiceClient.js";
import type { ItemTidyInput } from "../validators/itemTidyValidators.js";

/**
 * The customer's Review screen asking for its messy lines to be read.
 *
 * The sidecar already refuses an answer that drops or invents a word
 * (sugo_category/gemma.py parse_normalized). This re-checks the shape on this
 * side of the wire, because what comes back is model output headed straight
 * for a customer's list: a line the model mangled is left out, and that line
 * simply stays as the customer typed it.
 *
 * Always answers. "available: false" is the normal, quiet outcome of a
 * sidecar that is off, slow or out of quota; the phone then sends the rules'
 * version and says nothing alarming.
 */

const MAX_ITEMS_PER_LINE = 3;

const answerSchema = z.object({
  n: z.number().int().min(1),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        quantity: z.number().int().min(1).max(99),
        size: z.string().trim().max(40).optional().default(""),
        // An instruction the line carried ("paki pili yung walang bulok"). "" when none.
        note: z.string().trim().max(200).optional().default(""),
      })
    )
    .min(1)
    .max(MAX_ITEMS_PER_LINE),
  confident: z.boolean(),
});

export interface TidiedLine {
  id: string;
  items: Array<{ name: string; quantity: number; size: string | null; notes: string | null }>;
  /**
   * False when the model guessed. The customer app applies it anyway: the
   * sidecar already refused any reading that dropped or invented a word.
   */
  confident: boolean;
}

export interface TidyResponse {
  available: boolean;
  results: TidiedLine[];
  /** The model that answered, e.g. "gemini-3.8-flash". */
  model?: string;
  label?: string;
}

export async function tidyItemLines(input: ItemTidyInput): Promise<TidyResponse> {
  const answer = await normalizeItems(input.lines.map((line) => line.text));
  if (!answer || !answer.available || !Array.isArray(answer.results)) {
    return { available: false, results: [] };
  }

  const seen = new Set<number>();
  const results: TidiedLine[] = [];
  for (const raw of answer.results) {
    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { n, items, confident } = parsed.data;
    // n is 1-based. A number past the end, or one answered twice, is the model
    // losing track of which line is which; neither answer can be trusted.
    if (n > input.lines.length || seen.has(n)) continue;
    seen.add(n);
    results.push({
      id: input.lines[n - 1].id,
      items: items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        size: item.size || null,
        notes: item.note || null,
      })),
      confident,
    });
  }

  return { available: true, results, model: answer.model, label: answer.label };
}
