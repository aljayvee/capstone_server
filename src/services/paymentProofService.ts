import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { readText, configuredEngines } from "../lib/ocr/resilientOcrService.js";
import { parseTransfer, isSameDay, calendarDayOf } from "../lib/ocr/transferParser.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../repositories/errandPaymentRepository.js";
import { hasPaymentLedger } from "./patterns/paymentModes.js";
import { summarisePaymentPlan } from "./patterns/paymentLedger.js";
import { ServiceError } from "./ServiceError.js";
import type { PaymentProofUploadInput } from "../validators/paymentProofValidators.js";

/**
 * The customer's own payment confirmation, read by Cloud Vision.
 *
 * On a non-COD plan the customer pays through the company's Facebook Page and
 * the dispatcher has, until now, had to take that entirely on trust — they were
 * vouching for something they had seen in a different app. This gives them the
 * screenshot, and gives the screenshot a reading.
 *
 * The reading does NOT confirm the payment. A dispatcher still presses the
 * button, because OCR can be fooled by an edited image and the money is real.
 * What this does is make the attestation an informed one: the reference is
 * on file, the amount and date were checked against the errand, and anything
 * that does not line up is refused before it can be mistaken for evidence.
 */

/** Below this many recognised characters, the shot is unusable rather than odd. */
const MIN_LEGIBLE_CHARACTERS = 40;

/** How far the read amount may sit from what is owed. */
const AMOUNT_TOLERANCE_PESOS = 1;

function stripDataUri(data: string): string {
  return data.replace(/^data:[^;]+;base64,/, "");
}

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

export async function uploadPaymentProof(
  errandId: string,
  customerId: number,
  input: PaymentProofUploadInput
) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");
  if (errand.customerId !== customerId) {
    throw new ServiceError(403, "Access denied: this isn't your errand.");
  }

  const selection = await paymentSelectionRepository.findByErrandId(errandId);
  if (!hasPaymentLedger(selection)) {
    throw new ServiceError(
      409,
      "This errand is cash on delivery — you pay the rider at your door, so there's nothing to upload."
    );
  }

  const entries = await errandPaymentRepository.findAmountsByErrandId(errandId);
  const plan = summarisePaymentPlan({
    goodsSubtotal: errand.estimatedCost,
    grandTotal: errand.totalCost,
    entries,
    overagePending: false,
  });

  const base64 = stripDataUri(input.imageData);

  // ── read it ────────────────────────────────────────────────────────────
  const ocr = await readText(base64);
  if (!ocr) {
    // Two different failures wearing one shape: a customer who can retake the
    // screenshot needs to hear something other than one whose service is down.
    const engineAvailable = configuredEngines().length > 0;
    throw new ServiceError(
      engineAvailable ? 422 : 503,
      engineAvailable
        ? "We couldn't read that image. Make sure the whole receipt is in frame and try again."
        : "We can't check payment screenshots right now. Please try again in a moment — your order is not lost."
    );
  }

  const parsed = parseTransfer(ocr.text);

  if (parsed.characterCount < MIN_LEGIBLE_CHARACTERS) {
    throw new ServiceError(
      422,
      "That image came out too blurry to read. Take a screenshot rather than a photo of the screen if you can."
    );
  }

  // ── check it says what it needs to say ─────────────────────────────────
  //
  // Each of these is refused rather than stored-and-flagged, because a proof
  // that cannot be looked up, or that is for the wrong amount or the wrong day,
  // is not weak evidence — it is evidence of a different payment.

  if (!parsed.referenceNo) {
    throw new ServiceError(
      422,
      "We couldn't find a reference number on that receipt. Make sure the whole confirmation is visible, including the Ref No."
    );
  }

  if (parsed.amount === null) {
    throw new ServiceError(422, "We couldn't find the amount on that receipt. Try a clearer shot.");
  }

  if (Math.abs(parsed.amount - plan.dueUpFront) > AMOUNT_TOLERANCE_PESOS) {
    throw new ServiceError(
      422,
      `That receipt is for ${peso(parsed.amount)}, but ${peso(plan.dueUpFront)} is due. ` +
        `Upload the receipt for this order, or message your dispatcher if the amount is wrong.`
    );
  }

  if (!parsed.transactionDate) {
    throw new ServiceError(422, "We couldn't find the date on that receipt. Try a clearer shot.");
  }

  // Today, on the server's calendar — not in UTC.
  //
  // A payment made last week is a real payment for something else. Accepting an
  // old screenshot is the single easiest way to pay for one errand twice, and it
  // is the check a person eyeballing an image reliably skips.
  //
  // The comparison goes through calendarDayOf because Tacurong is UTC+8: a plain
  // UTC comparison rejects every valid receipt uploaded between local midnight
  // and 8am, which is exactly when a late-night errand gets paid for.
  if (!isSameDay(parsed.transactionDate, calendarDayOf(new Date()))) {
    throw new ServiceError(
      422,
      "That receipt isn't from today. Upload the confirmation for the payment you just sent."
    );
  }

  // ── one live proof per errand ──────────────────────────────────────────
  //
  // Replaces rather than accumulates: a customer who mis-shot the first attempt
  // should not leave a rejected image sitting in the dispatcher's evidence.
  await prisma.errandProofImage.deleteMany({ where: { errandId, kind: "PAYMENT_PROOF" } });

  const image = await prisma.errandProofImage.create({
    data: {
      errandId,
      customerId,
      riderId: null,
      kind: "PAYMENT_PROOF",
      imageData: base64,
      mimeType: input.mimeType,
      byteSize: input.fileSize,
      clarityScore: parsed.characterCount,
      clarityVerdict: parsed.characterCount > 300 ? "SHARP" : "ACCEPTABLE",
      extraction: {
        create: {
          engine: ocr.engine,
          rawText: ocr.text,
          extractedTotal: parsed.amount,
          extractedDate: parsed.transactionDate,
          referenceNo: parsed.referenceNo,
          transactionId: parsed.transactionId,
          confidence: ocr.confidence,
          status: "OK",
        },
      },
    },
    include: { extraction: true },
  });

  logger.info(
    `Errand ${errandId}: payment proof read by ${ocr.engine} — ` +
      `ref ${parsed.referenceNo}, ₱${parsed.amount}, ${parsed.transactionDate.toDateString()}.`
  );

  // The dispatcher is the one who confirms the money. Tell them it is waiting.
  eventPublisher.emitToErrand(errandId, "errand:payment_proof_uploaded", {
    errandId,
    referenceNo: parsed.referenceNo,
    transactionId: parsed.transactionId,
    amount: parsed.amount,
    transactionDate: parsed.transactionDate,
  });

  return image;
}

/** What the dispatcher and the customer see back. Never the image bytes. */
export async function getPaymentProof(errandId: string) {
  const image = await prisma.errandProofImage.findFirst({
    where: { errandId, kind: "PAYMENT_PROOF" },
    select: {
      id: true,
      capturedAt: true,
      clarityVerdict: true,
      extraction: {
        select: {
          extractedTotal: true,
          extractedDate: true,
          referenceNo: true,
          transactionId: true,
          engine: true,
        },
      },
    },
  });
  return image;
}
