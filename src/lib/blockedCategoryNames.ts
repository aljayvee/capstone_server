/**
 * Store-category names this system refuses to create.
 *
 * Bills payment is not a service offered here — this is a Pabili system, and a
 * rider cannot settle someone's electricity account. A category for it would put
 * an unfulfillable option in front of the customer.
 *
 * Blocking only the English spelling would be close to useless. Tacurong is in
 * Sultan Kudarat, and the ordinary Philippine name for one of these outlets is
 * "Bayad Center" — far likelier to be typed than "Bills & Payment Centers".
 *
 * `bayad` is the shared root for "payment" across Tagalog, Cebuano/Bisaya,
 * Hiligaynon/Ilonggo, Ilokano and Bicolano, so one entry covers most of the
 * region's languages at once.
 *
 * NOTE: the non-English terms want a native speaker's review. `bayad`, `bayarin`,
 * `singil`, `padala` and `sukot` are solid; the Ilokano and Bicolano inflections
 * are less certain, and Ayta/Ita terms are omitted rather than guessed at.
 */

/** Matched as a whole word, so "bayad" does not trip on "Bayambang". */
export const BLOCKED_CATEGORY_TOKENS: ReadonlyArray<{ term: string; language: string }> = [
  { term: "bills", language: "English" },
  { term: "utility", language: "English" },
  { term: "utilities", language: "English" },
  { term: "remittance", language: "English" },
  { term: "remit", language: "English" },

  { term: "bayad", language: "Tagalog / Cebuano / Hiligaynon / Ilokano / Bicolano" },
  { term: "bayarin", language: "Tagalog" },
  { term: "bayaran", language: "Tagalog / Hiligaynon" },
  { term: "bayadan", language: "Ilokano / Bicolano" },
  { term: "bayranan", language: "Cebuano / Bisaya" },
  { term: "bayaranan", language: "Cebuano / Bisaya" },
  { term: "singil", language: "Tagalog / Hiligaynon / Bicolano" },
  { term: "singilin", language: "Tagalog" },
  { term: "singir", language: "Ilokano" },
  { term: "sukot", language: "Cebuano / Hiligaynon" },
  { term: "padala", language: "Tagalog" },
];

/**
 * Matched anywhere in the normalised name.
 *
 * Utility words live here rather than in the token list on purpose: a bare
 * `tubig` would block "Tubig Refilling Station", which is a real Tacurong
 * business and a perfectly good Pabili stop. Paired with `bayad` it is
 * unambiguous.
 */
export const BLOCKED_CATEGORY_PHRASES: ReadonlyArray<{ term: string; language: string }> = [
  { term: "bill payment", language: "English" },
  { term: "payment center", language: "English" },
  { term: "payment centre", language: "English" },
  { term: "money transfer", language: "English" },
  // Listed as a phrase even though the bare `bayad` token would already catch
  // it: phrases are checked first, so the owner is told their name contains
  // "bayad center" rather than the vaguer "bayad". The specific message is the
  // difference between a usable rejection and a puzzling one.
  { term: "bayad center", language: "Tagalog" },
  { term: "bayad centre", language: "Tagalog" },
  { term: "pera padala", language: "Tagalog" },
  { term: "bayad tubig", language: "Tagalog (water bill)" },
  { term: "bayad kuryente", language: "Tagalog (electricity bill)" },

  // Brand-shaped names for the same service.
  { term: "palawan express", language: "brand" },
  { term: "cebuana", language: "brand" },
  { term: "ml kwarta", language: "brand" },
  { term: "western union", language: "brand" },
  { term: "bayad app", language: "brand" },
];

/**
 * Categories the seeder deactivates on every run.
 *
 * Kept in this module beside the blocked terms so the two cannot drift: a name
 * that gets retired should also be a name that cannot be re-created, and having
 * them in separate files is how that guarantee quietly rots.
 */
export const RETIRED_CATEGORY_NAMES: ReadonlyArray<string> = [
  "Bills & Payment Centers",
  "Pay Bills",
  "test1",
];

/**
 * Lowercase, strip diacritics, fold "&" to "and", drop punctuation, collapse
 * whitespace. So "BAYAD-CENTER", "Bayad & Payment" and "  bayad   center  " all
 * reduce to something comparable.
 */
export function normaliseCategoryName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface BlockedNameMatch {
  term: string;
  language: string;
}

/**
 * The blocked term this name contains, or null if it is fine.
 *
 * Returns the matched term rather than a boolean because the rejection message
 * has to name it. Over-blocking is the worse failure here — a wrongly blocked
 * name leaves the owner stuck with no idea why, whereas a missed one is caught at
 * the next seed run — so the error must give them something to act on.
 */
export function findBlockedCategoryTerm(name: string): BlockedNameMatch | null {
  const normalised = normaliseCategoryName(name);
  if (!normalised) return null;

  for (const phrase of BLOCKED_CATEGORY_PHRASES) {
    if (normalised.includes(normaliseCategoryName(phrase.term))) return phrase;
  }

  const words = new Set(normalised.split(" "));
  for (const token of BLOCKED_CATEGORY_TOKENS) {
    if (words.has(normaliseCategoryName(token.term))) return token;
  }

  return null;
}
