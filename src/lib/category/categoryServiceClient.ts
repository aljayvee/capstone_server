import { CATEGORY_SERVICE_URL, CATEGORY_SERVICE_TIMEOUT_MS } from "../../config/env.js";
import { CircuitBreaker } from "../routing/circuitBreaker.js";
import { logger } from "../logger.js";

/**
 * Talking to the Python category service (see server/ml/).
 *
 * Every function here answers `null` rather than throwing. That is the whole
 * contract: this service makes a guess better, it is never load-bearing. A
 * dispatcher pinning a shop at 9pm must not be blocked because a sidecar
 * container is restarting — the console falls back to the TypeScript rules in
 * storeCategoryInference.ts, which is how the feature worked before this
 * existed, and the pin keeps its "Category needed" mark.
 *
 * Same shape as the OSRM adapter next door, for the same reasons: a blank URL
 * skips the service entirely, and a breaker stops a dead host costing every
 * request a full timeout before the fallback runs.
 */

const breaker = new CircuitBreaker("category-service");

export interface CategoryPrediction {
  /** The merchant category NAME, or null when nothing cleared the threshold. */
  category: string | null;
  confidence: number;
  /** True only well above the threshold. Selects wording, never behaviour. */
  strong?: boolean;
  /** "name", "google+name", "empty" or "unavailable". */
  source: string;
  alternatives: Array<{ category: string; confidence: number }>;
  reason: string;
}

export function isCategoryServiceConfigured(): boolean {
  return Boolean(CATEGORY_SERVICE_URL);
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  if (!CATEGORY_SERVICE_URL) return null;
  if (!breaker.canAttempt()) return null;

  // An AbortController rather than the fetch option, because the budget here is
  // a dispatcher's patience: they are watching a panel while this resolves, and
  // a guess that arrives after they have already chosen by hand is worse than
  // no guess. Deliberately far tighter than the routing timeouts.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATEGORY_SERVICE_TIMEOUT_MS);

  try {
    const res = await fetch(`${CATEGORY_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      breaker.recordFailure();
      logger.warn(`Category service returned ${res.status} for ${path}.`);
      return null;
    }

    const data = (await res.json()) as T;
    breaker.recordSuccess();
    return data;
  } catch (err) {
    breaker.recordFailure();
    // Info, not error: an unreachable optional sidecar is a degraded guess, and
    // logging it at error level would page someone for a working system.
    logger.info(
      `Category service unreachable (${path}): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What kind of shop this name refers to. Null when the service cannot say. */
export function predictStoreCategory(
  name: string,
  googleTypes?: string[] | null
): Promise<CategoryPrediction | null> {
  return post<CategoryPrediction>("/categorize-store", {
    name,
    google_types: googleTypes?.length ? googleTypes : null,
  });
}

/** What kind of shop this item is bought at. Null when the service cannot say. */
export function predictItemCategory(name: string): Promise<CategoryPrediction | null> {
  return post<CategoryPrediction>("/categorize-item", { name });
}

/**
 * Several items in one call.
 *
 * Stage 3 reloads a whole basket when a dispatcher opens the editor, and one
 * round trip for eleven items beats eleven round trips inside a panel someone
 * is looking at.
 */
export async function predictItemCategories(
  names: string[]
): Promise<Array<CategoryPrediction & { name: string }> | null> {
  const data = await post<{ results: Array<CategoryPrediction & { name: string }> }>(
    "/categorize-items",
    { names }
  );
  return data?.results ?? null;
}
