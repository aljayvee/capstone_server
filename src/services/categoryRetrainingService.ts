/**
 * Category Retraining Service.
 *
 * Implements continuous auto-learning when an owner adds or updates a
 * MerchantCategory in the database.
 *
 * Uses a debounced timer (30 seconds) so rapid successive category edits
 * are coalesced into a single retraining / model-reload cycle rather than
 * spawning redundant processes.
 *
 * Until 2026-09-24 the "retrain" here only asked the Python service to POST
 * /reload, which re-read the same model files baked into its image: a new
 * category or a dispatcher's corrections never reached the model. It now reads
 * the catalogue and every labelled row (the same queries as
 * server/ml/sugo_category/train.py) and sends them to POST /retrain, which
 * trains in a separate process and swaps the models in once they load. The
 * container still never touches the database. jobs/categoryRetraining.ts also
 * runs it nightly, so each day's errands are learned without a category edit.
 */

import { CATEGORY_SERVICE_URL, CATEGORY_SERVICE_TIMEOUT_MS } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

const RETRAIN_DEBOUNCE_MS = 30_000;
let debounceTimer: NodeJS.Timeout | null = null;
let pendingReasons: Set<string> = new Set();

export interface RetrainTriggerPayload {
  reason: string;
  categoryId?: number;
}

/**
 * Enqueues a debounced model retraining request.
 * Call this when a MerchantCategory is created, updated, or deleted.
 */
export function triggerCategoryAutoLearning(payload: RetrainTriggerPayload): void {
  pendingReasons.add(payload.reason);

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  logger.info(
    `[Auto-Learning] Category change detected (${payload.reason}). Scheduling debounced retrain in ${RETRAIN_DEBOUNCE_MS / 1000}s...`
  );

  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    const reasons = Array.from(pendingReasons);
    pendingReasons.clear();
    await executeCategoryRetrain(reasons);
  }, RETRAIN_DEBOUNCE_MS);
}

export interface CategoryTrainingRows {
  categories: string[];
  /**
   * Each category's description. The trainer seeds a category the owner
   * created from its phrases ("nails, cement, paint") and moves the lexicon
   * items they name to it (server/ml/sugo_category/catalogue.py).
   */
  descriptions: Record<string, string>;
  /** [shop name, category name] */
  stores: Array<[string, string]>;
  /** [item name, category name] */
  items: Array<[string, string]>;
}

/**
 * The catalogue and every labelled row the category models learn from.
 *
 * Mirrors fetch_store_rows / fetch_item_rows in server/ml/sugo_category/train.py,
 * so a retrain from here and a Docker build from an export learn the same
 * thing. Rows are sent raw; the trainer drops the ones it cannot use
 * ("Unnamed Road", categories that are not active).
 */
export async function collectCategoryTrainingRows(): Promise<CategoryTrainingRows> {
  const active = await prisma.merchantCategory.findMany({
    where: { status: "Active" },
    select: { name: true, description: true },
  });
  const categories = active.map((c) => c.name.trim()).filter(Boolean);
  const descriptions: Record<string, string> = {};
  for (const c of active) {
    if (c.name.trim()) descriptions[c.name.trim()] = (c.description ?? "").trim();
  }

  const stores: Array<[string, string]> = [];
  const places = await prisma.verifiedPlace.findMany({
    where: { isActive: true },
    select: { name: true, keywords: true, category: { select: { name: true } } },
  });
  for (const place of places) {
    stores.push([place.name, place.category.name]);
    // Each alias the owner typed is its own row, as in the trainer.
    for (const alias of (place.keywords ?? "").split(",")) {
      const trimmed = alias.trim();
      if (trimmed.length >= 3) stores.push([trimmed, place.category.name]);
    }
  }
  // Not de-duplicated: a shop pinned forty times is forty votes.
  const pins = await prisma.errandPinpoint.findMany({
    where: { categoryId: { not: null }, storeName: { not: "" } },
    select: { storeName: true, category: { select: { name: true } } },
  });
  for (const pin of pins) {
    if (pin.category && pin.storeName.trim()) stores.push([pin.storeName, pin.category.name]);
  }

  const items: Array<[string, string]> = [];
  const itemQuery = {
    where: { storeCategory: { not: null }, NOT: { itemName: "" } },
    select: { itemName: true, storeCategory: true },
  } as const;
  const [details, requests] = await Promise.all([
    prisma.pabiliDetail.findMany(itemQuery),
    prisma.pabiliItemRequest.findMany(itemQuery),
  ]);
  for (const row of [...details, ...requests]) {
    // "Store 2 - Jollibee | Fast Food & Restaurant" -> the part after the pipe.
    const category = (row.storeCategory ?? "").split(" | ").pop()?.trim();
    if (category && row.itemName.trim()) items.push([row.itemName, category]);
  }

  return { categories, descriptions, stores, items };
}

/**
 * Sends the current catalogue and labelled rows to the Python service to learn.
 *
 * Returns once the service has accepted the job; the training itself runs in
 * the background there (GET /health shows how it went). Falls back to /reload
 * when the container predates /retrain, so an old image keeps its old
 * behaviour rather than erroring.
 */
export async function executeCategoryRetrain(reasons: string[]): Promise<boolean> {
  if (!CATEGORY_SERVICE_URL) {
    logger.info("[Auto-Learning] CATEGORY_SERVICE_URL is not configured; skipping retrain.");
    return false;
  }

  try {
    const rows = await collectCategoryTrainingRows();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(CATEGORY_SERVICE_TIMEOUT_MS, 15_000));
    const response = await fetch(`${CATEGORY_SERVICE_URL}/retrain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rows, reasons }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (response.status === 404) {
      return executeCategoryModelReload(reasons);
    }
    if (!response.ok) {
      logger.warn(`[Auto-Learning] Category service retrain returned HTTP ${response.status}`);
      return false;
    }
    logger.info(
      `[Auto-Learning] Category retrain accepted: ${rows.categories.length} categories, ` +
        `${rows.stores.length} store rows, ${rows.items.length} item rows (${reasons.join(", ")}).`
    );
    return true;
  } catch (err: any) {
    // Non-fatal: the models already loaded keep answering.
    logger.warn(`[Auto-Learning] Could not start a category retrain: ${err?.message || err}`);
    return false;
  }
}

/**
 * Why the models the category service is serving are out of date, or [] when
 * they are not.
 *
 * On 2026-09-25 the container was rebuilt with the Dockerfile's offline
 * default and served for hours with no Bakery class, so every bread was filed
 * under Fast Food and "pandesal" suggested Jollibee, while /health said "ok"
 * the whole time. Nothing noticed because nothing compared the models with the
 * catalogue. A retrain already running is not stale, just not finished.
 */
export function staleModelReasons(
  health: any,
  activeCategories: string[],
  labelledStoreRows: number
): string[] {
  if (!health || health.ready === false) return [];
  if (health.training?.state === "training") return [];
  const reasons: string[] = [];
  for (const kind of ["store", "item"] as const) {
    const model = health.models?.[kind];
    if (!model) {
      reasons.push(`no ${kind} model loaded`);
      continue;
    }
    const classes = new Set<string>((model.classes ?? []).map((c: string) => c.trim()));
    const missing = activeCategories.filter((c) => !classes.has(c));
    if (missing.length) reasons.push(`${kind} model lacks ${missing.join(", ")}`);
  }
  const storeReal = health.models?.store?.real_rows;
  if (typeof storeReal === "number" && storeReal === 0 && labelledStoreRows > 0) {
    reasons.push("store model learned none of production's own rows");
  }
  return reasons;
}

// A retrain takes minutes; a failing one must not be restarted every check.
const SELF_HEAL_MIN_GAP_MS = 2 * 60 * 60 * 1000;
let lastSelfHealAt = Number.NEGATIVE_INFINITY;

/**
 * Checks the served models against the catalogue and retrains when they are
 * stale. Run shortly after boot and on a timer (jobs/categoryRetraining.ts),
 * so a rebuilt or restored container heals itself within the hour instead of
 * waiting for the nightly retrain or for someone to notice the guesses.
 */
export async function ensureCategoryModelsCurrent(now = Date.now()): Promise<string[]> {
  if (!CATEGORY_SERVICE_URL) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(CATEGORY_SERVICE_TIMEOUT_MS, 5000));
    const response = await fetch(`${CATEGORY_SERVICE_URL}/health`, { signal: controller.signal }).finally(() =>
      clearTimeout(timeout)
    );
    if (!response.ok) return [];
    const health = await response.json();
    const [categories, labelledStoreRows] = await Promise.all([
      prisma.merchantCategory.findMany({ where: { status: "Active" }, select: { name: true } }),
      prisma.errandPinpoint.count({ where: { categoryId: { not: null } } }),
    ]);
    const active = categories.map((c) => c.name.trim()).filter(Boolean);
    const reasons = staleModelReasons(health, active, labelledStoreRows);
    if (!reasons.length) return [];
    if (now - lastSelfHealAt < SELF_HEAL_MIN_GAP_MS) {
      logger.warn(`[Auto-Learning] Category models still out of date (${reasons.join("; ")}); retrain already requested.`);
      return reasons;
    }
    lastSelfHealAt = now;
    logger.warn(`[Auto-Learning] Category models out of date: ${reasons.join("; ")}. Retraining.`);
    await executeCategoryRetrain([`self-heal: ${reasons.join("; ")}`]);
    return reasons;
  } catch (err: any) {
    logger.warn(`[Auto-Learning] Could not check the category models: ${err?.message || err}`);
    return [];
  }
}

/** Test seam: forget when the last self-heal retrain was asked for. */
export function resetCategorySelfHealForTests(): void {
  lastSelfHealAt = Number.NEGATIVE_INFINITY;
}

/**
 * Notifies the Python ML microservice to hot-reload its active category models.
 * Completely non-blocking and defensive: stays quiet if the microservice is offline.
 */
export async function executeCategoryModelReload(reasons: string[]): Promise<boolean> {
  if (!CATEGORY_SERVICE_URL) {
    logger.info("[Auto-Learning] CATEGORY_SERVICE_URL is not configured; skipping hot-reload.");
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(CATEGORY_SERVICE_TIMEOUT_MS, 5000));

    const response = await fetch(`${CATEGORY_SERVICE_URL}/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasons, triggeredAt: new Date().toISOString() }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      logger.warn(`[Auto-Learning] Category service reload returned HTTP ${response.status}`);
      return false;
    }

    const data: any = await response.json().catch(() => null);
    logger.info(`[Auto-Learning] Category models reloaded successfully. Status: ${data?.status ?? "ok"}`);
    return true;
  } catch (err: any) {
    // Non-fatal: if sidecar is offline, keep running without breaking core dispatch operations
    logger.warn(`[Auto-Learning] Could not notify category service: ${err?.message || err}`);
    return false;
  }
}
