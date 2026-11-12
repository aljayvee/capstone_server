import { LRUCache } from "lru-cache";
import { merchantCategoryRepository } from "../repositories/merchantCategoryRepository.js";

type MerchantCategoryList = Awaited<ReturnType<typeof merchantCategoryRepository.findMany>>;

const categoryCache = new LRUCache<string, MerchantCategoryList>({
  max: 10,
  ttl: 30 * 60 * 1000, // 30-minute TTL
});

export async function getCachedMerchantCategories(includeInactive = false): Promise<MerchantCategoryList> {
  const key = includeInactive ? "ALL" : "ACTIVE_ONLY";
  const cached = categoryCache.get(key);
  if (cached) return [...cached];

  const fresh = await merchantCategoryRepository.findMany({ includeInactive });
  categoryCache.set(key, fresh);
  return [...fresh];
}

export function invalidateMerchantCategoryCache(): void {
  categoryCache.clear();
}
