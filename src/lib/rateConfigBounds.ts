import { MAX_ADDITIONAL_STORES_CEILING } from "./storeLimitBounds.js";
import { HANDLING_AMOUNT_THRESHOLD } from "../services/patterns/pricingStrategy.js";

/** Inclusive numeric bounds for one configurable rate field. */
export interface RateFieldBound {
  min: number;
  max: number;
}

/**
 * Company and national-policy bounds for owner-configured service rates.
 *
 * Single-sourced on the server and published via `rateConfigService.PRICING_RULES`
 * so the Owner Portal form and the API validator enforce identical guardrails:
 * - Minimum floors on base and per-km rates protect fair rider earnings.
 * - Maximum caps prevent million-peso typos or exploitative pricing.
 */
export const RATE_CONFIG_BOUNDS = {
  baseFee: { min: 30, max: 300 },
  perKmRate: { min: 5, max: 100 },
  multiStoreFeePerStore: { min: 0, max: 200 },
  maxAdditionalStores: { min: 0, max: MAX_ADDITIONAL_STORES_CEILING },
  groceryFeeThreshold: { min: HANDLING_AMOUNT_THRESHOLD, max: 50000 },
  groceryFeeFlat: { min: 0, max: 500 },
  groceryFeePercent: { min: 0, max: 30 },
  nonCodThreshold: { min: 0, max: 50000 },
  nonCodFeeLow: { min: 0, max: 500 },
  nonCodFeeHigh: { min: 0, max: 500 },
} as const satisfies Record<string, RateFieldBound>;

export type RateConfigBounds = typeof RATE_CONFIG_BOUNDS;
