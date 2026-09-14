import { parseAmount } from "./receiptParser.js";

/**
 * Reads a customer's payment confirmation screenshot.
 *
 * A different problem from `receiptParser`, despite both being OCR over money.
 * A store receipt is thermal paper photographed under shop lighting, and the
 * question is "what was the total?". This is a screenshot — crisp, high
 * contrast, machine-rendered — and the question is "can this specific payment be
 * identified later?". That needs a reference the company can look up on its own
 * Facebook Page or bank statement, which is why a missing reference number is a
 * failure here even when the amount reads perfectly.
 *
 * Handles the formats actually seen in Tacurong: GCash, Maya, and bank transfer
 * confirmations from BPI/BDO/LandBank.
 */

export interface ParsedTransfer {
  /** The lookup handle — "Ref No.", "Reference ID", "Reference Number". */
  referenceNo: string | null;
  /**
   * A separate transaction identifier where the app prints one.
   *
   * Maya prints both a Reference ID and a Transaction ID; GCash prints only a
   * Ref No. Null is normal, not a failure — `referenceNo` is the one that must
   * be present.
   */
  transactionId: string | null;
  /** The amount sent. */
  amount: number | null;
  /** When the app says the transfer happened. */
  transactionDate: Date | null;
  /** Total characters recognised. A serviceable proxy for legibility. */
  characterCount: number;
}

/**
 * Label spellings seen in the wild, normalised.
 *
 * Ordered longest-first within each group so "reference number" is matched
 * before "reference", which otherwise swallows the more specific label and
 * captures the wrong side of the colon.
 */
const REFERENCE_LABELS = [
  "reference number",
  "reference no",
  "reference id",
  "reference",
  "ref no",
  "ref id",
  "ref",
];

const TRANSACTION_LABELS = [
  "transaction id",
  "transaction no",
  "transaction number",
  "txn id",
  "txn no",
];

const AMOUNT_LABELS = ["amount sent", "amount paid", "total amount", "amount", "you sent", "sent"];

function normalise(line: string): string {
  return line.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The value that follows a label on the same line, or on the next one.
 *
 * Both layouts are common: GCash prints "Ref No. 0123 4567 8901" inline, while
 * Maya stacks the label above its value. Trying only one shape misses half the
 * screenshots.
 */
function valueForLabels(lines: string[], labels: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const norm = normalise(lines[i]);
    for (const label of labels) {
      if (!norm.startsWith(label) && !norm.includes(` ${label}`)) continue;

      const idx = norm.indexOf(label) + label.length;
      const inline = lines[i].slice(idx).replace(/^[\s:.\-–—]+/, "").trim();
      if (inline) return inline;

      const next = lines[i + 1]?.trim();
      if (next) return next;
    }
  }
  return null;
}

/**
 * A reference as the company would type it into a search box.
 *
 * Spaces are stripped because the apps insert them purely for readability —
 * GCash shows "0123 4567 8901" for a twelve-digit reference — and a dispatcher
 * checking the Facebook Page against this needs the two to match. Everything
 * that is not alphanumeric goes, since no provider uses punctuation inside a
 * reference.
 */
function cleanReference(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, "");
  // Below eight characters it is far more likely to be a stray fragment — a
  // masked account tail, a page number — than a real reference.
  if (cleaned.length < 8 || cleaned.length > 40) return null;
  return cleaned.toUpperCase();
}

/**
 * The timestamp on the confirmation.
 *
 * E-wallets print a written month ("Sep 05, 2026") far more often than the
 * numeric dates POS printers use, so that shape is tried first; the numeric
 * fallback covers bank confirmations.
 */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function findTransferDate(lines: string[]): Date | null {
  const WRITTEN = /\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/i;
  const NUMERIC = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/;

  for (const line of lines) {
    const w = line.match(WRITTEN);
    if (w) {
      const month = MONTHS[w[1].slice(0, 3).toLowerCase()];
      const day = Number(w[2]);
      const year = Number(w[3]);
      if (month !== undefined && day >= 1 && day <= 31) {
        return new Date(Date.UTC(year, month, day));
      }
    }

    const n = line.match(NUMERIC);
    if (n) {
      const [, first, second, rawYear] = n;
      const a = Number(first);
      const b = Number(second);
      const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
      // Same disambiguation as receiptParser: a first component above 12 can
      // only be a day; genuinely ambiguous dates fall back to MM/DD.
      const dayFirst = a > 12 && b <= 12;
      const month = dayFirst ? b : a;
      const day = dayFirst ? a : b;
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return new Date(Date.UTC(year, month - 1, day));
      }
    }
  }
  return null;
}

export function parseTransfer(text: string): ParsedTransfer {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const rawAmount = valueForLabels(lines, AMOUNT_LABELS);
  let amount = rawAmount ? parseAmount(rawAmount) : null;

  // Fall back to the largest peso-formatted figure on the screenshot. Unlike a
  // store receipt — where the largest number is usually cash tendered, not the
  // total — a transfer confirmation has one headline amount and little else,
  // so the biggest figure is the right guess rather than the wrong one.
  if (amount === null) {
    const candidates = lines
      .map((l) => l.match(/(?:php|₱|p)\s?([\d.,]+)/i)?.[1])
      .map((m) => (m ? parseAmount(m) : null))
      .filter((n): n is number => n !== null);
    amount = candidates.length ? Math.max(...candidates) : null;
  }

  return {
    referenceNo: cleanReference(valueForLabels(lines, REFERENCE_LABELS)),
    transactionId: cleanReference(valueForLabels(lines, TRANSACTION_LABELS)),
    amount,
    transactionDate: findTransferDate(lines),
    characterCount: text.replace(/\s/g, "").length,
  };
}

/**
 * Whether two dates fall on the same calendar day.
 *
 * Compared in UTC because both sides are CALENDAR DATES rendered as UTC
 * midnight, not instants — see calendarDayOf for why that distinction matters.
 */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * The calendar day an instant falls on, in the SERVER's timezone, as UTC
 * midnight.
 *
 * A receipt prints a wall-clock date — "Sep 05, 2026" — with no timezone, and
 * findTransferDate turns that into UTC midnight of that calendar day. Comparing
 * it against `new Date()` in UTC then goes wrong for a third of every day here:
 * Tacurong is UTC+8, so between local midnight and 8am the UTC date is still
 * yesterday, and a customer uploading a receipt they had just been sent would be
 * told it "isn't from today".
 *
 * That window is exactly when a late-night errand gets paid for.
 */
export function calendarDayOf(instant: Date): Date {
  return new Date(Date.UTC(instant.getFullYear(), instant.getMonth(), instant.getDate()));
}
