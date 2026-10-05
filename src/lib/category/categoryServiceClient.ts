import {
  CATEGORY_ADVICE_TIMEOUT_MS,
  CATEGORY_SERVICE_URL,
  CATEGORY_SERVICE_TIMEOUT_MS,
} from "../../config/env.js";
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
// Its own breaker: a slow or refused second opinion must not open the one the
// category guesses depend on.
const adviceBreaker = new CircuitBreaker("category-service-advice");

export interface CategoryPrediction {
  /** The merchant category NAME, or null when nothing cleared the threshold. */
  category: string | null;
  confidence: number;
  /** True only well above the threshold. Selects wording, never behaviour. */
  strong?: boolean;
  /**
   * "name", "google+name", "empty" or "unavailable". "+gemma" is appended
   * when Gemma 4's answer was pooled in for a name the model was unsure of.
   */
  source: string;
  alternatives: Array<{ category: string; confidence: number }>;
  reason: string;
}

export function isCategoryServiceConfigured(): boolean {
  return Boolean(CATEGORY_SERVICE_URL);
}

async function post<T>(
  path: string,
  body: unknown,
  { timeoutMs = CATEGORY_SERVICE_TIMEOUT_MS, gate = breaker }: { timeoutMs?: number; gate?: CircuitBreaker } = {}
): Promise<T | null> {
  if (!CATEGORY_SERVICE_URL) return null;
  if (!gate.canAttempt()) return null;

  // An AbortController rather than the fetch option, because the budget here is
  // a dispatcher's patience: they are watching a panel while this resolves, and
  // a guess that arrives after they have already chosen by hand is worse than
  // no guess. Deliberately far tighter than the routing timeouts.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${CATEGORY_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      gate.recordFailure();
      logger.warn(`Category service returned ${res.status} for ${path}.`);
      return null;
    }

    const data = (await res.json()) as T;
    gate.recordSuccess();
    return data;
  } catch (err) {
    gate.recordFailure();
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

const LIVE_CATEGORY_TIMEOUT_MS = Math.max(CATEGORY_SERVICE_TIMEOUT_MS, 3500);

/** What kind of shop this name refers to. Null when the service cannot say. */
export function predictStoreCategory(
  name: string,
  googleTypes?: string[] | null
): Promise<CategoryPrediction | null> {
  return post<CategoryPrediction>(
    "/categorize-store",
    {
      name,
      google_types: googleTypes?.length ? googleTypes : null,
    },
    { timeoutMs: LIVE_CATEGORY_TIMEOUT_MS }
  );
}

export interface CommonItemSearch {
  /** Lexicon items matching the query, each with the kind of shop that sells it. */
  results: Array<{ name: string; category: string }>;
  /** The item model's guess for the text as typed; null below its confidence floor. */
  prediction: { name: string; category: string; confidence: number; source?: string } | null;
}

/**
 * Items the category service knows that match a search, for stage 3's Catalog
 * Helper. Null when the service cannot answer, like everything here.
 */
export function searchCommonItems(query: string, limit = 8): Promise<CommonItemSearch | null> {
  return post<CommonItemSearch>("/search-items", { query, limit }, { timeoutMs: LIVE_CATEGORY_TIMEOUT_MS });
}

/** What kind of shop this item is bought at. Null when the service cannot say. */
export function predictItemCategory(name: string): Promise<CategoryPrediction | null> {
  return post<CategoryPrediction>("/categorize-item", { name }, { timeoutMs: LIVE_CATEGORY_TIMEOUT_MS });
}

export interface Advice {
  available: boolean;
  /** One of the codes sent, or null: the model said none of the options fits. */
  code?: string | null;
  confidence?: number;
  /** The model that answered, e.g. "gemini-3.8-flash". */
  model?: string;
  /** Its name for a sentence, e.g. "Gemini 3.8 Flash". */
  label?: string;
  /** Why there is no answer, when there is none. */
  reason?: string;
}

/**
 * Which of `options` the facts and the rider's note support, per the
 * service's large models (Gemini, then Gemma behind it). The Conflict
 * Management second opinion; see exceptionReasonModel.adviceRequest. Null
 * when the service cannot be reached, like everything here.
 */
export function adviseChoice(request: {
  question: string;
  facts: string[];
  note: string;
  options: Array<{ code: string; text: string }>;
}): Promise<Advice | null> {
  return post<Advice>(
    "/advise",
    // Each model gets under half the budget, so Gemini and then Gemma can both
    // be tried and the answer still arrives before this request gives up.
    { ...request, timeout_ms: Math.max(500, Math.floor((CATEGORY_ADVICE_TIMEOUT_MS - 500) / 2)) },
    { timeoutMs: CATEGORY_ADVICE_TIMEOUT_MS, gate: adviceBreaker }
  );
}

/**
 * Have the service look at a new order's items now, before anyone asks.
 *
 * For a name the local model is unsure of, the service also asks Gemma 4,
 * which takes seconds, longer than this client waits. Asked when the customer
 * places the order, the answer is cached by the time a dispatcher opens it.
 * Fire and forget: the service replies at once, and nothing here is awaited.
 */
export function warmItemCategories(names: string[]): void {
  const cleaned = names.map((n) => n.trim()).filter(Boolean).slice(0, 100);
  if (cleaned.length === 0) return;
  void post("/warm", { kind: "item", names: cleaned });
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
    { names },
    { timeoutMs: LIVE_CATEGORY_TIMEOUT_MS }
  );
  return data?.results ?? null;
}

export interface SubstituteSuggestionResult {
  substitutes: string[];
  chatMessage: string;
  source: "ai" | "catalog";
}

export async function suggestItemSubstitutes(input: {
  itemName: string;
  storeName?: string;
  storeCategory?: string;
  customerName?: string;
}): Promise<SubstituteSuggestionResult | null> {
  return post<SubstituteSuggestionResult>(
    "/suggest-substitutes",
    {
      item_name: input.itemName,
      store_name: input.storeName ?? "",
      store_category: input.storeCategory ?? "",
      customer_name: input.customerName ?? "",
    },
    { timeoutMs: CATEGORY_ADVICE_TIMEOUT_MS, gate: adviceBreaker }
  );
}
