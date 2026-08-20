import { LRUCache } from "lru-cache";
import { tokenBlocklistRepository } from "../repositories/tokenBlocklistRepository.js";

// Caches "is this token revoked?" so authenticateToken (runs on every authenticated
// request) can skip the Prisma round-trip against TokenBlocklist on cache hits.
//
// revoked=true is cached for a long TTL (24h) — revocation is permanent for a given
// token, no correctness risk. revoked=false is cached for a short TTL only (30s):
// caching a "not revoked" result longer would mean a freshly-logged-out access token
// could still be accepted for up to that TTL after logout. This is a deliberate,
// bounded trade-off — up to 30s of possible revocation lag in exchange for cutting a
// DB round-trip from the vast majority of requests (valid, non-revoked tokens). In
// practice the logout path (see authService.revokeTokens) calls markRevoked()
// immediately, closing that gap entirely for the one revocation trigger this app has.
const NEGATIVE_TTL_MS = 30 * 1000;
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new LRUCache<string, boolean>({ max: 5000, ttl: NEGATIVE_TTL_MS });

export async function isRevoked(token: string): Promise<boolean> {
  const cached = cache.get(token);
  if (cached !== undefined) return cached;

  const record = await tokenBlocklistRepository.findByToken(token);
  const revoked = record !== null;
  cache.set(token, revoked, { ttl: revoked ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS });
  return revoked;
}

// Called right after a token is persisted to the DB blocklist so it's rejected on
// its very next use, without waiting for the negative-cache TTL to expire.
export function markRevoked(token: string): void {
  cache.set(token, true, { ttl: POSITIVE_TTL_MS });
}
