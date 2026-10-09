import { settlementRepository } from "../repositories/settlementRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../repositories/errandPaymentRepository.js";
import { riderCollectsCash, hasPaymentLedger } from "./patterns/paymentModes.js";
import { summarisePaymentPlan } from "./patterns/paymentLedger.js";
import { ServiceError } from "./ServiceError.js";
import { syncTransactionStatusQuietly } from "./transactionStatusService.js";

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
  input: {
    collectedInFull?: boolean;
    collectedAmount?: number;
    shortReason?: string;
    proofImageId?: number;
  }
) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  if (errand.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: you can only settle errands assigned to you.");
  }
  // Cash is reconciled after the handover, never before. A settlement filed on
  // an ASSIGNED or IN_TRANSIT errand locked in an expected amount that later
  // receipts would still have changed. The rider app PATCHes DELIVERED first
  // and only then settles (useRiderMission's advance step), so it never trips this.
  if (errand.status !== "DELIVERED" && errand.status !== "COMPLETED") {
    throw new ServiceError(409, "This errand can only be settled after it has been delivered.");
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
  // On GCash / PayMaya and Bank Transfer the customer usually transfers at the
  // door, and the rider's photo of it is recorded as paid (a FINAL row); an old
  // errand may also carry a 50% downpayment from before 2026-10-08. That money
  // never passes through the rider. Expecting the full totalCost would record
  // every such errand as SHORT by exactly that amount, feeding CASH_VARIANCE
  // exceptions and inflating shortageCount in riderPerformanceService.
  const alreadyPaid = hasPaymentLedger(selection)
    ? summarisePaymentPlan({
        grandTotal: errand.totalCost,
        entries: await errandPaymentRepository.findAmountsByErrandId(errandId),
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

  // A shortfall has to say why, or it is not reviewable, only recorded. Checked
  // here rather than in the validator because only this function knows the
  // expected amount, so only it knows whether a typed figure is short at all.
  if (status === "SHORT" && !input.shortReason?.trim()) {
    throw new ServiceError(400, "A reason is required when the settlement has a cash shortage.");
  }

  const settlement = await settlementRepository.create({
    errandId,
    riderId,
    expectedAmount,
    collectedAmount: round2(collectedAmount),
    variance,
    status,
    // Keep any rider explanation ("Cash nalang daw", "Keep the change (Tip)",
    // "Walang barya si customer") across SHORT, OVER, and MATCHED settlements.
    shortReason: input.shortReason?.trim() || null,
    proofImageId: input.proofImageId ?? null,
  });
  // Cash in hand is when a cash-on-delivery transaction is actually paid.
  syncTransactionStatusQuietly(errandId);
  return settlement;
}
