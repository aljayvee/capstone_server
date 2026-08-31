import { settlementRepository } from "../repositories/settlementRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { ServiceError } from "./ServiceError.js";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Gated to COD errands only — if the confirmed payment mode isn't COD, no
// cash changed hands, so there's nothing for the rider to reconcile.
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
  const isCod = !selection || selection.paymentMode.name === "Cash on Delivery";
  if (!isCod) {
    throw new ServiceError(400, "This errand's payment mode isn't Cash on Delivery — there's no cash to settle.");
  }

  const existing = await settlementRepository.findByErrandId(errandId);
  if (existing) {
    throw new ServiceError(409, "This errand has already been settled.");
  }

  const expectedAmount = errand.totalCost;

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
