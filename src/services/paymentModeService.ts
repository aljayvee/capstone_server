import { paymentModeRepository } from "../repositories/paymentModeRepository.js";

export function listPaymentModes() {
  return paymentModeRepository.findMany();
}
