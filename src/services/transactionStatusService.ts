import { errandRepository } from "../repositories/errandRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../repositories/errandPaymentRepository.js";
import { settlementRepository } from "../repositories/settlementRepository.js";
import { customerTransactionRepository } from "../repositories/customerTransactionRepository.js";
import { hasPaymentLedger } from "./patterns/paymentModes.js";
import { summarisePaymentPlan } from "./patterns/paymentLedger.js";
import { deriveTransactionStatus } from "./patterns/transactionStatus.js";
import { logger } from "../lib/logger.js";

/**
 * Re-derives customer_transactions.status from the errand, its ledger and its
 * cash settlement, and writes it.
 *
 * Re-reads everything rather than being told the new value, so a trigger fired
 * twice, or out of order, still lands on the right answer. Its own module with
 * only repository imports, so settlementService can call it without pulling in
 * errandService's routing and JWT chain.
 */
export async function syncTransactionStatus(errandId: string): Promise<void> {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) return;

  const selection = await paymentSelectionRepository.findByErrandId(errandId);
  const ledger = hasPaymentLedger(selection)
    ? summarisePaymentPlan({
        grandTotal: errand.totalCost,
        entries: await errandPaymentRepository.findAmountsByErrandId(errandId),
        cancelled: errand.status === "CANCELLED",
      })
    : null;
  const settlement = await settlementRepository.findByErrandId(errandId);

  const status = deriveTransactionStatus({
    errandStatus: String(errand.status),
    ledger,
    settlement: settlement ? { status: settlement.status } : null,
  });
  await customerTransactionRepository.updateStatusByErrandId(errandId, status);
}

/**
 * Fire-and-forget, like commissionService.recordCommission: a rider must never
 * see a delivery or a settlement fail because a bookkeeping row could not be
 * written.
 */
export function syncTransactionStatusQuietly(errandId: string): void {
  void syncTransactionStatus(errandId).catch((error) => {
    logger.error(`Could not sync the transaction status for errand ${errandId}:`, error);
  });
}
