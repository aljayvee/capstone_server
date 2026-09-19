import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { readText, configuredEngines } from "../lib/ocr/resilientOcrService.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../repositories/errandPaymentRepository.js";
import { hasPaymentLedger } from "./patterns/paymentModes.js";
import { summarisePaymentPlan, isOveragePending } from "./patterns/paymentLedger.js";
import { validateTransferReceipt } from "./patterns/transferValidation.js";
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

function stripDataUri(data: string): string {
  return data.replace(/^data:[^;]+;base64,/, "");
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
    // Was hardcoded false, so this endpoint never actually knew an overage was
    // pending — a customer could upload a proof re-validated against dueUpFront
    // (the already-paid figure) while OVERAGE_PENDING should have blocked it.
    overagePending: isOveragePending(errand),
  });

  // What's actually due right now, per the real ledger state — not always
  // dueUpFront. AWAITING_UPFRONT and AWAITING_BALANCE are the only two states
  // a customer-submitted receipt can ever settle; the rest either already have
  // no balance (SETTLED/REFUNDED) or are blocked on something a receipt can't
  // resolve (OVERAGE_PENDING, which needs a top-up attestation instead).
  const target =
    plan.state === "AWAITING_UPFRONT"
      ? { due: plan.dueUpFront, label: "payment" }
      : plan.state === "AWAITING_BALANCE"
        ? { due: plan.balanceDue, label: "balance" }
        : null;

  if (!target) {
    throw new ServiceError(409, "There's nothing currently due to upload a receipt for.");
  }

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

  const parsed = validateTransferReceipt({ ocrText: ocr.text, dueAmount: target.due, dueLabel: target.label });

  // ── supersede, don't delete ─────────────────────────────────────────────
  //
  // A reupload used to delete the previous PAYMENT_PROOF row outright — fine
  // for a mis-shot retake, but it also erased a rejected or later-disputed
  // screenshot the moment a new one arrived. Marking it superseded instead
  // keeps that history: the report joins ErrandPayment.proofImage to a
  // specific row, and a fraud dispute needs to see everything that was ever
  // submitted, not just whatever is current right now.
  await prisma.errandProofImage.updateMany({
    where: { errandId, kind: "PAYMENT_PROOF", supersededAt: null },
    data: { supersededAt: new Date() },
  });

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
    where: { errandId, kind: "PAYMENT_PROOF", supersededAt: null },
    orderBy: { capturedAt: "desc" },
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
