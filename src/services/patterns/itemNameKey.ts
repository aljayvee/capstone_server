/**
 * Reducing an item name to the key two dispatchers would agree on.
 *
 * "Pandesal (10pcs)", "pandesal 10 pcs" and "Pandesal" are one decision as far
 * as "which shop sells this" is concerned, and so are "Paracetamol 500mg" and
 * "Paracetamol 250mg". The learned memory is keyed on this reduction rather
 * than on the raw text, because a memory that only fires on a byte-identical
 * repeat would almost never fire at all — customers and dispatchers type the
 * same item a dozen different ways.
 *
 * Deliberately conservative: it strips quantities and packaging, never words.
 * Dropping a word risks collapsing two genuinely different items onto one key,
 * and a confidently wrong shop sends a rider to the wrong counter.
 */

/** Packaging and unit tokens that never identify what a thing is. */
const UNIT_TOKENS = new Set([
  "pc", "pcs", "piece", "pieces", "pk", "pack", "packs", "box", "boxes",
  "btl", "bottle", "bottles", "can", "cans", "sachet", "sachets", "pouch",
  "kg", "kilo", "kilos", "g", "gram", "grams", "mg", "ml", "l", "liter",
  "litre", "liters", "litres", "dozen", "doz", "set", "sets", "pair", "pairs",
  "bundle", "roll", "rolls", "tab", "tabs", "tablet", "tablets", "cap",
  "caps", "capsule", "capsules", "x",
]);

const PARENTHETICAL = /\([^)]*\)/g;
const PUNCT = /[^a-z0-9\s]+/g;
const SPACE = /\s+/g;
/** A number optionally glued to a unit: "500mg", "10pcs", "1.5l", "4pk". */
const QUANTITY = /^\d+(?:[.,]\d+)?[a-z]*$/;

export function itemNameKey(raw: string | null | undefined): string {
  if (!raw) return "";

  const withoutParens = String(raw).toLowerCase().replace(PARENTHETICAL, " ");
  const tokens = withoutParens.replace(PUNCT, " ").replace(SPACE, " ").trim().split(" ");

  const kept = tokens.filter((token) => {
    if (!token) return false;
    if (UNIT_TOKENS.has(token)) return false;
    // "500mg" and "10pcs" arrive as one token once punctuation is gone.
    if (QUANTITY.test(token)) return false;
    return true;
  });

  // Never reduce to nothing. An item genuinely called "2x4" still has to be
  // keyed on something, and an empty key would collide with every other
  // unparseable name in the table.
  return (kept.length > 0 ? kept : tokens).join(" ").trim();
}
