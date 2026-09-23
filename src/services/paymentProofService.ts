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
import * as errandPaymentService from "./errandPaymentService.js";
import type { PaymentProofUploadInput } from "../validators/paymentProofValidators.js";

/**
 * The customer's own payment confirmation, read by Cloud Vision.
 *
 * On a non-COD plan the customer pays through the company's Facebook Page and
 * the dispatcher has, until now, had to take that entirely on trust — they were
 * vouching for something they had seen in a different app. This gives them the
 * screenshot, and gives the screenshot a reading.
 *
 * Anything that does not line up is refused before it can be mistaken for
 * evidence: the reference is on file, and the amount and date were checked
 * against the errand. For the mid-way half-payment, a receipt that passes those
 * checks now confirms the payment by itself (settleAutomatically, below); a
 * reused reference number and the balance still wait for a dispatcher.
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

  // The half is taken on what the rider actually paid, so it cannot be owed
  // before the rider has bought everything and asked for it. A receipt sent
  // earlier would be checked against half the customer's ESTIMATE, then either
  // fail to match the real figure or settle the wrong amount.
  if (target.label === "payment" && !errand.halfPaymentRequestedAt) {
    throw new ServiceError(
      409,
      "Your rider hasn't finished buying yet. We'll ask for the half-payment once they have, so it's half of what they actually paid."
    );
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
      `ref ${parsed.referenceNo}, ₱${parsed.amount}, ${parsed.transactionDate.toDateString()}` +
      // Spelled out rather than left implicit. When a network fee has been taken
      // off, the stored figure deliberately differs from the one printed large
      // on the customer's screenshot, and anyone reconciling the two later needs
      // to see why without re-deriving it.
      (parsed.feeExcluded
        ? ` (net of a ₱${parsed.transferFee} transfer fee; receipt headline ₱${parsed.amount + (parsed.transferFee ?? 0)}).`
        : ".")
  );

  eventPublisher.emitToErrand(errandId, "errand:payment_proof_uploaded", {
    errandId,
    referenceNo: parsed.referenceNo,
    transactionId: parsed.transactionId,
    amount: parsed.amount,
    transactionDate: parsed.transactionDate,
  });

  const review = await settleAutomatically(errandId, target.label, image.id, parsed);
  if (!review.autoConfirmed) {
    await errandPaymentService.publishPaymentUpdate(errandId, "proof_uploaded");
  }

  return { image, ...review };
}

/**
 * Confirms the half-payment from the customer's own receipt, when it can.
 *
 * This used to always wait for a dispatcher to press a button, on the grounds
 * that OCR can be fooled. The owner asked for it to settle on its own, and the
 * receipt that reaches this point has already passed validateTransferReceipt:
 * the amount is within ₱1 of the half, the transfer happened today, and it has
 * a reference number. What that cannot see is the same screenshot being spent
 * twice, so a reference number already used on another errand is the one case
 * held back for a person. So is the balance: that is collected at the door and
 * was never part of this flow.
 *
 * The ledger row carries no person (confirmedByUserId null) and names the
 * receipt instead, so the audit trail says exactly what happened.
 */
async function settleAutomatically(
  errandId: string,
  label: string,
  proofImageId: number,
  parsed: { referenceNo: string; amount: number }
): Promise<{ autoConfirmed: boolean; reviewReason: "reference_reused" | "not_half_payment" | "confirm_failed" | null }> {
  if (label !== "payment") return { autoConfirmed: false, reviewReason: "not_half_payment" };

  if (await errandPaymentRepository.isReferenceUsedElsewhere(parsed.referenceNo, errandId)) {
    logger.warn(
      `Errand ${errandId}: receipt ref ${parsed.referenceNo} already backs another errand; left for a dispatcher.`
    );
    return { autoConfirmed: false, reviewReason: "reference_reused" };
  }

  try {
    await errandPaymentService.confirmUpfrontPayment(errandId, null, {
      amount: parsed.amount,
      proofImageId,
      note: `Confirmed automatically from the customer's receipt, ref ${parsed.referenceNo}.`,
    });
    return { autoConfirmed: true, reviewReason: null };
  } catch (err) {
    // A race with a dispatcher confirming by hand lands here as a 409, which is
    // the right outcome. Anything else leaves it for a person, not lost.
    logger.warn(`Errand ${errandId}: automatic confirmation declined: ${(err as Error).message}`);
    return { autoConfirmed: false, reviewReason: "confirm_failed" };
  }
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
