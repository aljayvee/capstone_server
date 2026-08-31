import { rateConfigRepository, type RateConfigInput } from "../repositories/rateConfigRepository.js";
import {
  BASE_FEE_DISTANCE_KM,
  HANDLING_AMOUNT_THRESHOLD,
  HANDLING_ITEM_UNITS_THRESHOLD,
} from "./patterns/pricingStrategy.js";

/**
 * The parts of the formula the owner cannot edit, published alongside the parts
 * they can.
 *
 * The owner portal runs a live fee simulator, and it has to compute against the
 * values currently in the form — including unsaved ones — so it cannot simply
 * ask the server to price a draft. That means a second implementation of the
 * formula, and a second implementation drifts: when the base-fee radius last
 * moved, the simulator went on showing the old figure, quietly telling the owner
 * something untrue about their own rates.
 *
 * Sending the constants makes the numbers themselves single-sourced even though
 * the arithmetic is duplicated, so a change here reaches the simulator without
 * anyone remembering to go and edit it.
 */
export interface PricingRules {
  /** Kilometres included in the base fare before the per-km rate applies. */
  baseFeeDistanceKm: number;
  /** Item units above which a handling fee applies regardless of value. */
  handlingItemUnitsThreshold: number;
  /** Basket value at or above which a handling fee applies regardless of size. */
  handlingAmountThreshold: number;
}

export const PRICING_RULES: PricingRules = {
  baseFeeDistanceKm: BASE_FEE_DISTANCE_KM,
  handlingItemUnitsThreshold: HANDLING_ITEM_UNITS_THRESHOLD,
  handlingAmountThreshold: HANDLING_AMOUNT_THRESHOLD,
};

export async function getRateConfig() {
  const config = await rateConfigRepository.findFirst();
  if (!config) return config;

  return { ...config, pricingRules: PRICING_RULES };
}

export function updateRateConfig(data: RateConfigInput) {
  return rateConfigRepository.upsert(data);
}
