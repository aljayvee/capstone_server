import { LRUCache } from "lru-cache";
import { rateConfigRepository } from "../repositories/rateConfigRepository.js";

type RateConfigRecord = NonNullable<Awaited<ReturnType<typeof rateConfigRepository.findFirst>>>;

const configCache = new LRUCache<string, RateConfigRecord>({
  max: 5,
  ttl: 15 * 60 * 1000, // 15-minute TTL
});

export async function getCachedRateConfig(): Promise<RateConfigRecord | null> {
  const cached = configCache.get("PRIMARY_RATE_CONFIG");
  if (cached) return { ...cached };

  const fresh = await rateConfigRepository.findFirst();
  if (fresh) configCache.set("PRIMARY_RATE_CONFIG", fresh);
  return fresh ? { ...fresh } : null;
}

export function invalidateRateConfigCache(): void {
  configCache.delete("PRIMARY_RATE_CONFIG");
}
