import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { paymentModeRepository } from "../repositories/paymentModeRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { customerTransactionRepository } from "../repositories/customerTransactionRepository.js";
import { ServiceError } from "./ServiceError.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { attachErrandNames, recalculateFee } from "./errandService.js";
import { hasPaymentLedger, PAYMENT_MODE_COD } from "./patterns/paymentModes.js";
import type { CreatePaymentSelectionInput } from "../validators/paymentSelectionValidators.js";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function getPaymentSelection(errandId: string) {
  return paymentSelectionRepository.findByErrandId(errandId);
}

// Writes only the terminal, already-confirmed choice — the client-side
// PROMPTED -> SELECTING -> CONFIRMING -> CONFIRMED flow (see
// PaymentModeSelectionModal.tsx in CustomerApp) lives entirely on the device;
// this service never sees the intermediate states, only the final CONFIRMED one.
export async function confirmPaymentSelection(
  errandId: string,
  customerId: number,
  input: CreatePaymentSelectionInput
) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }
  if (errand.customerId !== customerId) {
    throw new ServiceError(403, "Access denied: you can only set the payment mode for your own errand.");
  }
  if (!errand.paymentEnabledAt) {
    throw new ServiceError(409, "The dispatcher hasn't enabled payment mode selection for this errand yet.");
  }

  const existing = await paymentSelectionRepository.findByErrandId(errandId);
  if (existing) {
    throw new ServiceError(409, "A payment mode has already been confirmed for this errand.");
  }

  const paymentMode = await paymentModeRepository.findById(input.paymentModeId);
  if (!paymentMode) {
    throw new ServiceError(404, "Payment mode not found");
  }
  // Defense-in-depth: the client already disables the 3 not-yet-integrated
  // methods (paymentMethodStrategy.ts's UnavailableStrategy on the client), but
  // a disabled button is a UI courtesy, not a security boundary — reject here too.
  if (paymentMode.status !== "Active") {
    throw new ServiceError(400, `${paymentMode.name} is not available yet.`);
  }

  const selection = await paymentSelectionRepository.create(errandId, input.paymentModeId);
  await customerTransactionRepository.updatePaymentMethodByErrandId(errandId, paymentMode.name);
  const paidErrand = await errandRepository.update(errandId, { paymentModeId: input.paymentModeId });

  // To this errand's people only; it went to every connected client.
  eventPublisher.emitToErrandParties(
    errandId,
    { riderId: paidErrand?.riderId ?? null, customerId: paidErrand?.customerId ?? null },
    "payment:selected",
    {
      errandId,
      paymentMode: selection.paymentMode,
      confirmedAt: selection.confirmedAt,
    }
  );

  // Idempotent recompute, awaited (unlike a push notification, this is real
  // pricing data the errand record now depends on — not safe to fire-and-
  // forget). A no-op today since COD is the only reachable mode (matches
  // what recalculateFee already assumes by default); only actually changes
  // the total once a non-COD mode is reachable (see pricingStrategy.ts's
  // nonCodFee).
  await recalculateFee(errandId);

  return selection;
}

/**
 * The customer chose GCash/PayMaya or a bank transfer, then paid the rider in
 * cash at the door ("They're paying cash instead").
 *
 * The errand's own payment mode becomes Cash on Delivery. The PaymentSelection
 * row is left as it is, because it is the customer's confirmed choice and is
 * never overwritten; the disagreement between the two is what tells every
 * client the method changed (paymentModes.paymentMethodChangeOf).
 *
 * The non-COD fee comes off, and only that: the stamped fee is taken out of the
 * delivery fee, the total and the agreed fare, rather than the whole fare being
 * re-measured at the door (recalculateFee would re-route and could move it by
 * more than the fee). The agreed fare matters because recalculateFee holds the
 * fare to it; leaving the fee in there would put it back on the next reprice.
 * priceForStops also prices a switched errand as COD from here on. The rider
 * app expects the same figure at the door: the balance less this fee.
 *
 * Returns whether anything changed. A COD errand, or one already switched, is
 * left alone, so a retaken cash photo is harmless.
 */
export async function switchToCashOnDelivery(errandId: string): Promise<boolean> {
  const selection = await paymentSelectionRepository.findByErrandId(errandId);
  if (!hasPaymentLedger(selection)) return false;

  const cod = await paymentModeRepository.findByName(PAYMENT_MODE_COD);
  if (!cod) {
    throw new ServiceError(500, `The "${PAYMENT_MODE_COD}" payment mode is missing from the catalogue.`);
  }

  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand || errand.paymentModeId === cod.id) return false;

  const fee = Math.max(0, errand.nonCodFee ?? 0);
  const totalCost = round2(errand.totalCost - fee);
  await errandRepository.update(errandId, {
    paymentModeId: cod.id,
    ...(fee > 0
      ? {
          nonCodFee: 0,
          deliveryFee: round2(errand.deliveryFee - fee),
          totalCost,
          ...(errand.quotedDeliveryFee != null
            ? { quotedDeliveryFee: round2(errand.quotedDeliveryFee - fee) }
            : {}),
        }
      : {}),
  });
  // The customer's transaction row carries the total too (see recalculateFee).
  if (fee > 0) await customerTransactionRepository.updateAmountByErrandId(errandId, totalCost);

  // The customer's screen redraws from this, the same event a status change
  // sends, so the struck-through method appears without a pull to refresh.
  const updated = await errandRepository.findById(errandId);
  if (updated) {
    eventPublisher.emitToErrandParties(
      errandId,
      { riderId: updated.riderId ?? null, customerId: updated.customerId ?? null },
      "order:updated",
      attachErrandNames(updated)
    );
  }
  return true;
}
