/**
 * Pulls the payable total out of OCR'd receipt text.
 *
 * Every rule here was written against three real Tacurong receipts — SaveMore
 * Primark, 7-Eleven and Jollibee — and each one exists because a simpler version
 * got the wrong answer on at least one of them. The traps are documented inline
 * rather than in a commit message because the next person to touch this will
 * reach for the simpler version otherwise.
 *
 * What it deliberately does NOT do is parse line items. Receipts are printed in
 * two columns, and when photographed at an angle the OCR reading order
 * interleaves names and prices out of step — on the SaveMore sample the first
 * price appears before the first item name. The totals block is reliably ordered;
 * the item block is not, and the flow only needs one figure.
 */

export interface ParsedReceipt {
  /** The payable amount. Null when no total could be identified. */
  total: number | null;
  subtotal: number | null;
  /**
   * Cash tendered, parsed only so it can be excluded. It is usually the LARGEST
   * number on the receipt, which is exactly why "take the biggest figure" is the
   * wrong heuristic — on the SaveMore sample it is ₱1,005 against a ₱994 total.
   */
  cashTendered: number | null;
  /** Transaction date, where one could be identified. Never the permit date. */
  transactionDate: Date | null;
  /** Total characters recognised. A serviceable proxy for legibility. */
  characterCount: number;
}

/**
 * Reads one money value out of a fragment of OCR text.
 *
 * Handles, in order of how badly each broke the naive version:
 *  - `"1.005.00"` — Vision reads a thousands COMMA as a period. `parseFloat`
 *    turns that into 1.005, off by a factor of 1000.
 *  - `"PHP 176.00"` — Jollibee prints the currency code on the value.
 *  - `"55.00V"` — a VAT marker in the adjacent column, glued on by OCR.
 *  - `"11.00-"` — trailing sign on a change line.
 *
 * Returns null rather than guessing when there is no two-decimal amount, so
 * `"1.005"` (a stray three-decimal item price) is rejected instead of silently
 * becoming ₱1.01.
 */
export function parseAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/(?:php|peso|₱)/gi, " ")
    .replace(/[^\d.,]/g, "")
    .trim();

  // Anchor on the final separator + exactly two digits; everything before it is
  // grouping, whichever glyph OCR chose for it.
  const match = cleaned.match(/^([\d.,]*?)([.,])(\d{2})$/);
  if (!match) return null;

  const whole = match[1].replace(/[.,]/g, "") || "0";
  const value = Number(`${whole}.${match[3]}`);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Labels that mean "this is what you pay", most specific first.
 *
 * Order is load-bearing. `TOTAL DUE` must be tried before `TOTAL`, and `TOTAL`
 * must never match `SUBTOTAL` — hence the word-boundary check in `labelMatch`.
 */
const TOTAL_LABELS = ["total due", "amount due", "grand total", "total amount", "total"];
const SUBTOTAL_LABELS = ["subtotal", "sub total", "sub-total"];
const CASH_LABELS = ["cash tendered", "cash payment", "cash"];

function normalise(line: string): string {
  return line.toLowerCase().replace(/[_\s]+/g, " ").trim();
}

/**
 * True when the line STARTS with this label as a whole word.
 *
 * Prefix rather than equality because 7-Eleven prints `Total (3)` with the item
 * count welded to the label — an equality check finds nothing. The
 * boundary check is what stops `total` matching `subtotal`.
 */
function labelMatch(line: string, label: string): boolean {
  const norm = normalise(line);
  if (!norm.startsWith(label)) return false;
  const next = norm.charAt(label.length);
  return next === "" || !/[a-z]/.test(next);
}

/**
 * The amount belonging to a label, wherever the layout put it.
 *
 * Three receipts, three layouts:
 *   SaveMore   `Total` / `994.00`          -> value on the next line
 *   7-Eleven   `Total (3)` / `134.00`      -> label carries a suffix
 *   Jollibee   `Subtotal PHP 176.00`       -> value on the same line
 *              `TOTAL DUE` / `PHP 176.00`  -> next line, currency prefixed
 *
 * Looks two lines ahead because a currency code occasionally lands on its own.
 */
function amountForLabels(lines: string[], labels: string[]): number | null {
  for (const label of labels) {
    for (let i = 0; i < lines.length; i++) {
      if (!labelMatch(lines[i], label)) continue;

      const rest = normalise(lines[i]).slice(label.length);
      const sameLine = parseAmount(rest);
      if (sameLine !== null) return sameLine;

      for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
        const next = parseAmount(lines[j]);
        if (next !== null) return next;
      }
    }
  }
  return null;
}

/**
 * The transaction date.
 *
 * Explicitly NOT the line labelled "Date Issued". On every one of the three
 * chains that label belongs to the BIR permit printed at the foot of the
 * receipt — on the 7-Eleven sample it reads `03/01/2020`, six years before the
 * purchase. Taking the labelled date is the obvious move and it is wrong.
 *
 * The real transaction date sits near the top beside the time, so this scans for
 * a bare date and skips any line mentioning a permit.
 */
function findTransactionDate(lines: string[]): Date | null {
  const DATE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/;

  for (const line of lines) {
    const norm = normalise(line);
    if (/date issued|ptu|accreditation|valid until|permit/.test(norm)) continue;

    const m = line.match(DATE);
    if (!m) continue;

    // Both orders appear in the wild, on receipts from the same city:
    //   7-Eleven / Jollibee  ->  MM/DD/YYYY   ("08/16/2026")
    //   SaveMore             ->  DD/MM/YY     ("22/08/26")
    //
    // Disambiguated by range: a first component above 12 can only be a day.
    // Genuinely ambiguous dates (both parts ≤ 12) fall back to MM/DD, which is
    // what the majority of Philippine POS printers emit.
    const [, first, second, rawYear] = m;
    const a = Number(first);
    const b = Number(second);
    const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);

    const dayFirst = a > 12 && b <= 12;
    const month = dayFirst ? b : a;
    const day = dayFirst ? a : b;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;

    const date = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function parseReceipt(text: string): ParsedReceipt {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    total: amountForLabels(lines, TOTAL_LABELS),
    subtotal: amountForLabels(lines, SUBTOTAL_LABELS),
    cashTendered: amountForLabels(lines, CASH_LABELS),
    transactionDate: findTransactionDate(lines),
    characterCount: text.replace(/\s/g, "").length,
  };
}
