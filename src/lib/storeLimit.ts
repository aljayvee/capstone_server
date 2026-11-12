import { getCachedRateConfig } from "./rateConfigCache.js";
import { ServiceError } from "../services/ServiceError.js";
import { storesAllowedFor, storeLimitMessage } from "./storeLimitBounds.js";

export * from "./storeLimitBounds.js";

/** 1 + the owner's Max Additional Stores Allowed. See storeLimitBounds.ts. */
export async function getStoresAllowed(): Promise<number> {
  const config = await getCachedRateConfig();
  return storesAllowedFor(config?.maxAdditionalStores);
}

/**
 * `alreadyHas` keeps an errand that was filed under a higher limit editable
 * after the owner lowers it: its stops may be re-saved, just not added to.
 */
export async function assertWithinStoreLimit(count: number, alreadyHas = 0): Promise<void> {
  const allowed = await getStoresAllowed();
  if (count > Math.max(allowed, alreadyHas)) throw new ServiceError(422, storeLimitMessage(allowed));
}
