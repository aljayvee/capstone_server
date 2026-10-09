import { prisma } from "../lib/prisma.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../repositories/errandPaymentRepository.js";
import { hasPaymentLedger } from "./patterns/paymentModes.js";
import { summarisePaymentPlan } from "./patterns/paymentLedger.js";
import { ServiceError } from "./ServiceError.js";
import type { PaymentProofUploadInput } from "../validators/paymentProofValidators.js";

/**
 * The customer's own payment screenshot.
 *
 * Until 2026-10-08 this was how a customer on GCash / PayMaya or Bank Transfer
 * sent the 50% downpayment: they uploaded the screenshot, Cloud Vision read it,
 * and the half settled on its own. The downpayment is retired. The whole bill is
 * now paid at the door, and the RIDER photographs the customer's confirmation
 * (proofImageService, RIDER_BALANCE_PROOF), which the system reads and records
 * (errandPaymentService.confirmBalanceFromRiderProof).
 *
 * So an upload here is refused, with where to go instead. Recording it would let
 * the same bill be paid twice, once here and again at the door, and installed
 * customer apps still show the button.
 */
export async function uploadPaymentProof(
  errandId: string,
  customerId: number,
  _input: PaymentProofUploadInput
): Promise<never> {
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

  const plan = summarisePaymentPlan({
    grandTotal: errand.totalCost,
    entries: await errandPaymentRepository.findAmountsByErrandId(errandId),
  });
  if (plan.state === "AWAITING_BALANCE") {
    throw new ServiceError(
      409,
      "You pay when your items arrive. Show your GCash, PayMaya or bank confirmation to your rider, and they take a photo of it."
    );
  }
  throw new ServiceError(409, "There's nothing currently due to upload a receipt for.");
}

/**
 * The latest payment screenshot a customer uploaded, for errands from before
 * 2026-10-08. What the dispatcher and the customer see back. Never the bytes.
 */
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
