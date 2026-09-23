import { parseTransfer, isSameDay, calendarDayOf } from "../../lib/ocr/transferParser.js";
import { ServiceError } from "../ServiceError.js";

/**
 * The fraud checks a GCash/Maya/bank transfer receipt must pass before it is
 * evidence of anything, shared by whoever is photographing it — the customer,
 * uploading their own screenshot (paymentProofService.ts), or the rider,
 * photographing the customer's screen at the door (proofImageService.ts).
 *
 * Extracted rather than duplicated: a reference-number requirement, an amount
 * tolerance and a same-day window are exactly the kind of rule that quietly
 * drifts apart when two files each carry their own copy, and drifting apart
 * here means one of the two paths gets easier to defraud than the other.
 */

/** Below this many recognised characters, the shot is unusable rather than odd. */
const MIN_LEGIBLE_CHARACTERS = 40;

/** How far the read amount may sit from what is owed. */
const AMOUNT_TOLERANCE_PESOS = 1;

/**
 * Money as a customer reads it.
 *
 * `toFixed(2)` alone renders ₱1,120 as "1120.00" — legible to a parser, harder
 * for a person comparing it against the figure on their phone, which is the
 * entire job of these messages.
 */
function peso(amount: number): string {
  return `₱${amount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface TransferValidationInput {
  ocrText: string;
  /** What must be on the receipt for it to count — dueUpFront or balanceDue. */
  dueAmount: number;
  /** How the mismatch message names `dueAmount` — "payment" or "balance". */
  dueLabel: string;
}

export interface TransferValidationResult {
  referenceNo: string;
  transactionId: string | null;
  /**
   * What this payment is worth to us: the figure that matched what was owed,
   * with any network fee already taken out of it.
   */
  amount: number;
  /** The fee the receipt printed, kept for the ledger. Null when it printed none. */
  transferFee: number | null;
  /** True when `amount` is the headline MINUS the fee rather than the headline itself. */
  feeExcluded: boolean;
  transactionDate: Date;
  characterCount: number;
}

/**
 * The amounts a receipt could honestly be claiming, best first.
 *
 * An InstaPay send out of Maya prints one headline figure and a separate
 * "Transfer Fee ₱10.00", and the receipt does not say in so many words whether
 * the headline is the amount the recipient got or the total the sender was
 * debited. Both readings exist across Philippine e-wallets, and the difference
 * is exactly the fee.
 *
 * Rather than pick one and be wrong half the time, both are offered and
 * whichever reconciles with what is actually owed is the one taken. This cannot
 * manufacture a false match out of nothing: the two candidates differ by a fee
 * the receipt itself printed and which is stored alongside the result, so a
 * dispatcher reviewing the proof sees the arithmetic rather than a bare number.
 *
 * The fee is never counted as money received either way. It went to the rails,
 * not to us, and billing a customer as though we had it would overcharge them by
 * the fee on every single InstaPay payment.
 */
function candidateAmounts(
  headline: number,
  fee: number | null,
  totalSent: number | null
): number[] {
  if (fee === null || fee <= 0) return [headline];

  // Unless the receipt does the sum for us.
  //
  // GCash prints an "Amount" and a "Total Amount Sent". When the second is the
  // first plus the fee, the receipt has stated in its own figures that the
  // headline is the principal and the fee sat on top of it. There is nothing
  // left to infer, so the ambiguity below is skipped and the guessing window
  // closes entirely.
  //
  // A receipt that prints no total simply misses this branch and falls through
  // to the two-candidate reading, so nothing depends on any given app printing
  // it. The rule can only ever turn a guess into a certainty.
  if (totalSent !== null && Math.abs(totalSent - (headline + fee)) < 0.01) {
    return [headline];
  }

  // Net first. A headline that already excludes the fee still matches on the
  // second candidate, so leading with the net costs nothing and means the
  // ambiguous case resolves towards charging the customer less, not more.
  const net = Number((headline - fee).toFixed(2));
  return net > 0 ? [net, headline] : [headline];
}

/**
 * Parses and validates a transfer receipt against what's actually due.
 *
 * Each failure is refused rather than stored-and-flagged, because a proof that
 * cannot be looked up, or that is for the wrong amount or the wrong day, is not
 * weak evidence — it is evidence of a different payment.
 */
export function validateTransferReceipt(input: TransferValidationInput): TransferValidationResult {
  const parsed = parseTransfer(input.ocrText);

  if (parsed.characterCount < MIN_LEGIBLE_CHARACTERS) {
    throw new ServiceError(
      422,
      "That image came out too blurry to read. Take a screenshot rather than a photo of the screen if you can."
    );
  }

  if (!parsed.referenceNo) {
    throw new ServiceError(
      422,
      "We couldn't find a reference number on that receipt. Make sure the whole confirmation is visible, including the Ref No."
    );
  }

  if (parsed.amount === null) {
    throw new ServiceError(422, "We couldn't find the amount on that receipt. Try a clearer shot.");
  }

  const candidates = candidateAmounts(parsed.amount, parsed.transferFee, parsed.totalSent);
  const matched = candidates.find(
    (candidate) => Math.abs(candidate - input.dueAmount) <= AMOUNT_TOLERANCE_PESOS
  );

  if (matched === undefined) {
    // Report the headline, because that is the figure printed large on the
    // screen the customer is looking at. Quoting them a net amount they cannot
    // see anywhere on their own receipt reads as a system error rather than a
    // mismatch, and they cannot act on it.
    throw new ServiceError(
      422,
      `That receipt is for ${peso(parsed.amount)}, but ${peso(input.dueAmount)} ${input.dueLabel === "balance" ? "is the balance due" : "is due"}. ` +
        `Upload the receipt for this order, or message your dispatcher if the amount is wrong.`
    );
  }

  if (!parsed.transactionDate) {
    throw new ServiceError(422, "We couldn't find the date on that receipt. Try a clearer shot.");
  }

  // Today, on the server's calendar — not in UTC.
  //
  // A payment made last week is a real payment for something else. Accepting
  // an old screenshot is the single easiest way to pay for one errand twice —
  // or, at the door, for a rider to be shown the same real receipt on two
  // different deliveries — and it is the check a person eyeballing an image
  // reliably skips.
  //
  // The comparison goes through calendarDayOf because Tacurong is UTC+8: a
  // plain UTC comparison rejects every valid receipt uploaded between local
  // midnight and 8am, which is exactly when a late-night errand gets paid for.
  if (!isSameDay(parsed.transactionDate, calendarDayOf(new Date()))) {
    throw new ServiceError(
      422,
      "That receipt isn't from today. Upload the confirmation for the payment you just sent."
    );
  }

  return {
    referenceNo: parsed.referenceNo,
    transactionId: parsed.transactionId,
    amount: matched,
    transferFee: parsed.transferFee,
    feeExcluded: matched !== parsed.amount,
    transactionDate: parsed.transactionDate,
    characterCount: parsed.characterCount,
  };
}
