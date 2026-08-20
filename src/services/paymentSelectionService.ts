import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { paymentModeRepository } from "../repositories/paymentModeRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { ServiceError } from "./ServiceError.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { recalculateFee } from "./errandService.js";
import type { CreatePaymentSelectionInput } from "../validators/paymentSelectionValidators.js";

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
  eventPublisher.emit("payment:selected", {
    errandId,
    paymentMode: selection.paymentMode,
    confirmedAt: selection.confirmedAt,
  });

  // Idempotent recompute, awaited (unlike a push notification, this is real
  // pricing data the errand record now depends on — not safe to fire-and-
  // forget). A no-op today since COD is the only reachable mode (matches
  // what recalculateFee already assumes by default); only actually changes
  // the total once a non-COD mode is reachable (see pricingStrategy.ts's
  // nonCodFee).
  await recalculateFee(errandId);

  return selection;
}
