import { settlementRepository } from "../repositories/settlementRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../repositories/errandPaymentRepository.js";
import { riderCollectsCash, isDownpaymentPlan } from "./patterns/paymentModes.js";
import { summarisePaymentPlan } from "./patterns/paymentLedger.js";
import { ServiceError } from "./ServiceError.js";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Records the cash that came back.
 *
 * `collectedAmount` is deliberately optional. On the default path the client
 * sends `collectedInFull` and NOTHING ELSE, and the expected figure below is
 * used — so the amount recorded cannot be influenced by the device. The rider
 * app used to ask the rider to type what they collected, which made
 * under-reporting a matter of typing a smaller number.
 *
 * A genuine shortfall still has to be recordable, and it has no other source, so
 * an explicit amount is accepted — and lands as SHORT, with a reason, where
 * dispatch can see it.
 */
export async function submitSettlement(
  errandId: string,
  riderId: number,
  input: { collectedInFull?: boolean; collectedAmount?: number; shortReason?: string }
) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  if (errand.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: you can only settle errands assigned to you.");
  }

  const selection = await paymentSelectionRepository.findByErrandId(errandId);

  // The 50% downpayment plan DOES put cash in the rider's hands — the balance,
  // collected at the door — so it settles like any other errand. Only a mode
  // where the rider carries nothing has nothing to reconcile.
  //
  // This used to reject everything that was not Cash on Delivery outright, which
  // was right while COD was the only reachable mode and wrong the moment it
  // stopped being.
  if (!riderCollectsCash(selection)) {
    throw new ServiceError(
      400,
      "This errand's payment mode doesn't put cash in the rider's hands — there's nothing to settle."
    );
  }

  const existing = await settlementRepository.findByErrandId(errandId);
  if (existing) {
    throw new ServiceError(409, "This errand has already been settled.");
  }

  // What the rider is expected to hand back, which is not the same as the bill.
  //
  // On the downpayment plan the customer has already paid part of it through the
  // Facebook Page, and that money never passes through the rider. Expecting the
  // full totalCost would record every such errand as SHORT by exactly the
  // downpayment — feeding CASH_VARIANCE exceptions and inflating shortageCount
  // in riderPerformanceService, so riders doing exactly their job would read as
  // chronic short-collectors.
  const alreadyPaid = isDownpaymentPlan(selection)
    ? summarisePaymentPlan({
        goodsSubtotal: errand.estimatedCost,
        grandTotal: errand.totalCost,
        entries: await errandPaymentRepository.findAmountsByErrandId(errandId),
        overagePending: false,
      }).amountPaid
    : 0;

  const expectedAmount = round2(Math.max(0, errand.totalCost - alreadyPaid));

  // The server's figure wins unless the rider is explicitly reporting a
  // discrepancy. An amount sent alongside collectedInFull is ignored rather
  // than trusted.
  const collectedAmount =
    input.collectedInFull || input.collectedAmount === undefined
      ? expectedAmount
      : input.collectedAmount;

  const variance = round2(collectedAmount - expectedAmount);
  const status = variance === 0 ? "MATCHED" : variance > 0 ? "OVER" : "SHORT";

  return settlementRepository.create({
    errandId,
    riderId,
    expectedAmount,
    collectedAmount: round2(collectedAmount),
    variance,
    status,
    // Only meaningful on a shortfall; a matched settlement has nothing to explain.
    shortReason: status === "SHORT" ? input.shortReason?.trim() || null : null,
  });
}
