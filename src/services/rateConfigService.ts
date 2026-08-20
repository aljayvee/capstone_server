import { rateConfigRepository, type RateConfigInput } from "../repositories/rateConfigRepository.js";

export function getRateConfig() {
  return rateConfigRepository.findFirst();
}

export function updateRateConfig(data: RateConfigInput) {
  return rateConfigRepository.upsert(data);
}
