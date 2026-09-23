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
  /**
   * The network fee the app printed as its own line, where it printed one.
   *
   * Maya prints "Transfer Fee" on every send receipt — ₱0.00 for wallet-to-wallet
   * and ₱10.00 for an InstaPay transfer out to another bank or e-wallet. It is
   * money the sender paid to the rails, not to us, so it must never be counted
   * as part of what was received. Null means the receipt printed no fee line at
   * all, which is not the same as a fee of zero: zero is a fact the receipt
   * asserts, null is a fact it withholds.
   */
  transferFee: number | null;
  /**
   * The "total sent" figure, where the app prints one ALONGSIDE the amount.
   *
   * GCash prints both: an "Amount" and a "Total Amount Sent". On a free
   * wallet-to-wallet send the two are identical and it tells us nothing, but on
   * a transfer that carries a fee the pair states the arithmetic outright, which
   * is the one thing Maya's receipt never does. See `candidateAmounts`.
   */
  totalSent: number | null;
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
  // Maya's InstaPay receipts print a second identifier under "InstaPay Ref. No".
  // It is the NETWORK's handle, not Maya's, and it is the only one that appears
  // on the receiving side — a dispatcher reconciling against the GCash account
  // that was paid will find this number and not the Maya Reference ID. That is
  // exactly the secondary-identifier role transactionId already exists to fill.
  "instapay ref no",
  "instapay ref",
];

const AMOUNT_LABELS = ["amount sent", "amount paid", "total amount", "amount", "you sent", "sent"];

/**
 * What the sender was debited in total, as distinct from what was sent.
 *
 * Kept apart from AMOUNT_LABELS rather than folded into it: the two are the same
 * number on most receipts, and the whole value of reading this one separately is
 * the case where they differ by a fee.
 */
const TOTAL_SENT_LABELS = ["total amount sent", "total amount", "total sent", "total debited"];

/**
 * What the app charged for moving the money.
 *
 * Ordered longest-first for the same reason as the reference labels: "transfer
 * fee" must be consumed before a bare "fee" can match half of it.
 */
const FEE_LABELS = [
  "transfer fee",
  "instapay fee",
  "service fee",
  "convenience fee",
  "sending fee",
  "fee",
];

/**
 * Lines that look like a reference but belong to a different numbering scheme.
 *
 * "InstaPay Ref. No" contains "ref", so the reference scan would otherwise stop
 * on it and hand back the network's six-digit id as though it were Maya's
 * Reference ID. The two are not interchangeable: only the Maya one can be looked
 * up in the sender's own app.
 */
const NOT_A_PRIMARY_REFERENCE = /instapay\s+ref/i;

function normalise(line: string): string {
  return line.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The form a line is matched against, with abbreviating full stops removed.
 *
 * The label list spells things out — "instapay ref no" — while the receipt
 * abbreviates: "InstaPay Ref. No". Leaving the stops in means the longer label
 * never matches and the shorter "instapay ref" wins instead, taking "Ref." as
 * the whole label and handing back "No 531488" as the value.
 *
 * Only the copy used for FINDING a label is flattened. Values are always sliced
 * out of the original line, so nothing here can damage a number.
 */
function normaliseForLabel(line: string): string {
  return normalise(line).replace(/\./g, "");
}

/**
 * A label, as a pattern that survives the gap between the normalised copy and
 * the original line.
 *
 * The words are rejoined with a flexible whitespace run because Vision preserves
 * column alignment: a Maya table row arrives as "Reference ID      DBBF 0A06
 * 2BB7", and an abbreviating full stop ("Ref. No") sits inside the label rather
 * than after it.
 */
function labelPattern(label: string): RegExp {
  const words = label.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(words.join("\\.?\\s+") + "\\.?", "i");
}

/**
 * Every value that follows one of these labels, in reading order.
 *
 * Both layouts are common: GCash prints "Ref No. 0123 4567 8901" inline, while
 * Maya stacks the label above its value. Trying only one shape misses half the
 * screenshots.
 *
 * ALL matches are returned rather than only the first, because a match is not
 * yet a usable value. "Sent money to" satisfies the `sent` amount label and
 * yields "money to", which is not a number; stopping there returned null for the
 * whole receipt even when the real figure sat two lines below. The caller keeps
 * reading until something converts.
 */
function valuesForLabels(lines: string[], labels: string[], exclude?: RegExp): string[] {
  const found: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const norm = normaliseForLabel(lines[i]);
    if (exclude?.test(norm)) continue;

    for (const label of labels) {
      if (!norm.startsWith(label) && !norm.includes(` ${label}`)) continue;

      // Located in the ORIGINAL line, not by the normalised index. The two only
      // agree when the line has single spaces and no leading padding; Vision
      // emits neither reliably, and the mismatch silently sliced the first
      // characters off the value.
      const match = lines[i].match(labelPattern(label));
      if (!match) continue;

      const inline = lines[i]
        .slice(match.index! + match[0].length)
        .replace(/^[\s:.\-–—]+/, "")
        .trim();
      if (inline) {
        found.push(inline);
        break;
      }

      const next = lines[i + 1]?.trim();
      if (next) {
        found.push(next);
        break;
      }
    }
  }

  return found;
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
function cleanReference(raw: string | null, minLength = 8): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, "");
  // Below eight characters it is far more likely to be a stray fragment — a
  // masked account tail, a page number — than a real reference.
  if (cleaned.length < minLength || cleaned.length > 40) return null;
  return cleaned.toUpperCase();
}

/**
 * The candidate with a date sheared off the end of it.
 *
 * GCash prints the reference and the timestamp as two columns of ONE line —
 * "Ref No. 3045 023 780733    Sep 14, 2026 9:11 AM" — so everything after the
 * label is the reference AND the date. Stripping punctuation then welded them
 * into "3045023780733SEP142026911AM", which is 27 characters, passes every
 * length check, and is not a number that exists anywhere in GCash.
 *
 * That failure was silent, which is the worst kind here: the dispatcher is
 * handed a reference they cannot look up, with nothing to suggest it is wrong.
 */
function withoutTrailingDate(raw: string): string | null {
  for (const pattern of [WRITTEN, DAY_FIRST, NUMERIC]) {
    const match = raw.match(pattern);
    if (match?.index) return raw.slice(0, match.index).trim();
  }
  return null;
}

/**
 * The first candidate that survives cleaning, in reading order.
 *
 * The shortened form is tried first and the full string kept as a fallback, so
 * the trim can only ever rescue a value, never destroy one: if cutting at the
 * date leaves too little to be a reference, the original is used unchanged.
 */
function firstReference(candidates: string[], minLength?: number): string | null {
  for (const candidate of candidates) {
    const trimmed = withoutTrailingDate(candidate);
    const cleaned =
      (trimmed ? cleanReference(trimmed, minLength) : null) ??
      cleanReference(candidate, minLength);
    if (cleaned) return cleaned;
  }
  return null;
}

/** The first candidate that reads as money, in reading order. */
function firstAmount(candidates: string[]): number | null {
  for (const candidate of candidates) {
    const value = parseAmount(candidate);
    if (value !== null) return value;
  }
  return null;
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

const WRITTEN = /\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/i;
// The same date with the day in front: "22 Sep 2026, 11:16 pm".
//
// Maya prints BOTH shapes, and which one you get depends on the screen rather
// than the transaction: its "Sent money to" receipt reads "Sep 22, 2026" while
// the "Transferred money" screen for the very same transfer reads "22 Sep
// 2026". Supporting only the month-first shape meant one of those two screens
// parsed to no date at all, and a receipt with no date is refused outright —
// so a customer who screenshotted the wrong Maya screen could not pay.
const DAY_FIRST = /\b(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})\b/i;
const NUMERIC = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/;

function findTransferDate(lines: string[]): Date | null {
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

    const d = line.match(DAY_FIRST);
    if (d) {
      const month = MONTHS[d[2].slice(0, 3).toLowerCase()];
      const day = Number(d[1]);
      const year = Number(d[3]);
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

/**
 * Maya's headline figure, which carries no label whatsoever.
 *
 * Every label in AMOUNT_LABELS is absent from a Maya receipt: the amount is the
 * first thing on the screen, rendered as a signed wallet movement — "- ₱108.00"
 * — with the word "Amount" nowhere on the page. The leading minus is the signal,
 * and it is a specific one: a fee line ("₱10.00") and an account number never
 * carry it, so this cannot capture them by mistake.
 */
const SIGNED_HEADLINE = /^[-–—+]\s*(?:php|₱|p)\s?([\d.,]+)$/i;

export function parseTransfer(text: string): ParsedTransfer {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const transferFee = firstAmount(valuesForLabels(lines, FEE_LABELS));

  let amount = firstAmount(valuesForLabels(lines, AMOUNT_LABELS));

  // Then Maya's unlabelled headline.
  if (amount === null) {
    for (const line of lines) {
      const headline = line.trim().match(SIGNED_HEADLINE);
      const value = headline ? parseAmount(headline[1]) : null;
      if (value !== null) {
        amount = value;
        break;
      }
    }
  }

  // Fall back to the largest peso-formatted figure on the screenshot. Unlike a
  // store receipt — where the largest number is usually cash tendered, not the
  // total — a transfer confirmation has one headline amount and little else,
  // so the biggest figure is the right guess rather than the wrong one.
  //
  // The fee line is excluded rather than out-sized: it only loses to `max`
  // because a ₱10 charge is smaller than the transfer it sits under, which is an
  // accident of these amounts and not a rule. A ₱15 InstaPay fee on a ₱10 top-up
  // would otherwise be read as the payment.
  if (amount === null) {
    const feeLines = new Set(
      lines.filter((l) => FEE_LABELS.some((label) => normaliseForLabel(l).includes(label)))
    );
    const candidates = lines
      .filter((l) => !feeLines.has(l))
      .map((l) => l.match(/(?:php|₱|p)\s?([\d.,]+)/i)?.[1])
      .map((m) => (m ? parseAmount(m) : null))
      .filter((n): n is number => n !== null);
    amount = candidates.length ? Math.max(...candidates) : null;
  }

  return {
    referenceNo: firstReference(
      valuesForLabels(lines, REFERENCE_LABELS, NOT_A_PRIMARY_REFERENCE)
    ),
    // Six rather than eight, because this one is always explicitly labelled and
    // Maya's InstaPay Ref. No is a bare six-digit number. The eight-character
    // floor guards the primary reference against unlabelled fragments; it has
    // nothing to defend here, and applying it discarded a real identifier.
    transactionId: firstReference(valuesForLabels(lines, TRANSACTION_LABELS), 6),
    amount,
    transferFee,
    totalSent: firstAmount(valuesForLabels(lines, TOTAL_SENT_LABELS)),
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
