import { settlementRepository } from "../repositories/settlementRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { ServiceError } from "./ServiceError.js";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Gated to COD errands only — if the confirmed payment mode isn't COD, no
// cash changed hands, so there's nothing for the rider to reconcile.
export async function submitSettlement(errandId: string, riderId: number, collectedAmount: number) {
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
  const variance = round2(collectedAmount - expectedAmount);
  const status = variance === 0 ? "MATCHED" : variance > 0 ? "OVER" : "SHORT";

  return settlementRepository.create({
    errandId,
    riderId,
    expectedAmount,
    collectedAmount: round2(collectedAmount),
    variance,
    status,
  });
}
