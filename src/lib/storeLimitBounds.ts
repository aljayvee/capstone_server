/**
 * How many stores one errand may visit: the first store, which every errand
 * has, plus the owner's "Max Additional Stores Allowed" (RateConfig).
 *
 * The cap used to be a literal 3 in the validators, the dispatcher's pin step,
 * the store predictor and the customer app, so raising the setting from 2 to 5
 * changed nothing anywhere (2026-10-25). Every check now reads the rate card
 * through storeLimit.ts.
 *
 * Kept free of imports so the request schemas can use the bounds without
 * loading the database layer.
 */

/** The most the owner may set. The rate card's own input stops here too. */
export const MAX_ADDITIONAL_STORES_CEILING = 5;

/**
 * A structural bound for the request schemas, which are static and cannot read
 * the rate card. The real limit is enforced by assertWithinStoreLimit.
 */
export const STORE_COUNT_CEILING = 1 + MAX_ADDITIONAL_STORES_CEILING;

/** The column default, for a server with no rate card row yet. */
const DEFAULT_MAX_ADDITIONAL_STORES = 2;

export function storesAllowedFor(maxAdditionalStores: number | null | undefined): number {
  const extra = Number.isFinite(maxAdditionalStores)
    ? Math.round(maxAdditionalStores as number)
    : DEFAULT_MAX_ADDITIONAL_STORES;
  return 1 + Math.min(Math.max(extra, 0), MAX_ADDITIONAL_STORES_CEILING);
}

export function storeLimitMessage(allowed: number): string {
  return allowed === 1
    ? "An errand can visit 1 store."
    : `An errand can visit up to ${allowed} stores.`;
}
