import { prisma } from "../lib/prisma.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { merchantCategoryRepository } from "../repositories/merchantCategoryRepository.js";
import { ServiceError } from "./ServiceError.js";
import { itemNameKey } from "./patterns/itemNameKey.js";
import { inferItemCategories } from "./categoryInferenceService.js";

/**
 * Where should this item be bought, given the shops this errand has pinned?
 *
 * Stage 3 of the dispatcher console asks this for every line. It has two
 * answers available and they are not equally good:
 *
 *   1. **Learned.** A dispatcher has filed this exact item before. Those
 *      decisions are already in `pabili_details_tbl` — every time stage 3 sends
 *      an item list, it writes the shop and category a human chose. That is
 *      real supervision, sitting unused. Reading it back is what makes this
 *      feature learn from the dispatcher rather than merely predict at them.
 *   2. **Modelled.** Nobody has filed it before, so the Python classifier reads
 *      the name (see server/ml).
 *
 * Learned beats modelled every time, and by a wide margin: a model that reads
 * "Lozartan" as Pharmacy is guessing from spelling, while a dispatcher who
 * filed it under Mercury Drug last Tuesday is remembering. The model's job is
 * the long tail.
 *
 * Both answers are a CATEGORY. Turning that into one of this errand's actual
 * pinned shops happens last, because the shops differ per errand — the same
 * item goes to a different pin on every order.
 */

/** How long the learned memory is held before it is re-read. */
const MEMORY_TTL_MS = 60_000;

/**
 * How many past decisions are loaded. Bounded because this is read on an
 * interactive panel, and because the newest decisions are the ones worth
 * having: a shop that closed last month should stop being suggested.
 */
const MEMORY_ROW_LIMIT = 4000;

/**
 * Below this the learned answer is reported but not treated as settled.
 *
 * 0.75, not 0.6: at 0.6 a two-of-three majority read as settled even though a
 * third of the dispatchers who met this item had filed it somewhere else. This
 * decision sends a rider to a counter, so a third dissenting is worth a glance.
 * 0.75 makes three-of-four settled and two-of-three contested.
 */
const CONTESTED_AGREEMENT = 0.75;

/**
 * Below this, say "once before" rather than asserting a pattern.
 *
 * A single prior decision is 100% agreement with itself, which would otherwise
 * be presented with the same confidence as forty consistent ones.
 */
const PATTERN_MIN_SAMPLES = 2;

export interface ItemPlacement {
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  /** The pinned stop to file this under, when one of them fits. */
  pinpointId: number | null;
  storeName: string | null;
  confidence: number;
  /** "learned" | "model" | "none" */
  source: string;
  /** How many past dispatcher decisions back a learned answer. */
  learnedFrom: number;
  reason: string;
}

interface MemoryEntry {
  /** categoryId -> how many times a dispatcher chose it for this item. */
  byCategory: Map<number, number>;
  total: number;
}

/** One remembered filing, kept with its errand so an errand never learns from itself. */
interface MemoryRow {
  errandId: string;
  categoryId: number;
}

let memoryCache: { at: number; rows: Map<string, MemoryRow[]> } | null = null;

/**
 * Every past decision a DISPATCHER made about where an item is bought, keyed
 * by the reduced item name.
 *
 * Two rules keep this honest, and both were found by running a real order
 * through the console on 2026-09-23:
 *
 *  1. Only rows the dispatcher console filed count. `pabili_details_tbl` is
 *     also written when the CUSTOMER places the order, carrying their own bare
 *     category pick ("Bakery"). Counting those presented a customer's guess
 *     as a dispatcher's remembered decision - including their mistakes. Stage
 *     3 is the only writer of the "Store 2 - Julie's | Bakery" form, so the
 *     " | " separator is what marks a row as a human dispatcher's filing.
 *  2. An errand never learns from its own rows. Without this, every item on
 *     the order being asked about answered "learned once before" at 100% -
 *     from itself - and echoed the customer's pick straight back.
 *
 * The model still trains on the customer rows at build time, where they are
 * useful general signal. They are just not evidence of what a dispatcher did.
 */
async function loadMemory(): Promise<Map<string, MemoryRow[]>> {
  if (memoryCache && Date.now() - memoryCache.at < MEMORY_TTL_MS) {
    return memoryCache.rows;
  }

  const [rows, categories] = await Promise.all([
    prisma.pabiliDetail.findMany({
      where: { itemName: { not: "" }, storeCategory: { contains: " | " } },
      select: {
        errandId: true,
        itemName: true,
        storeCategory: true,
        pinpoint: { select: { categoryId: true } },
      },
      orderBy: { id: "desc" },
      take: MEMORY_ROW_LIMIT,
    }),
    merchantCategoryRepository.findMany({ includeInactive: false }),
  ]);

  const byName = new Map<string, { id: number; name: string }>(
    categories.map((c: { id: number; name: string }) => [c.name.trim().toLowerCase(), c])
  );

  const byKey = new Map<string, MemoryRow[]>();

  for (const row of rows) {
    const key = itemNameKey(row.itemName);
    if (!key) continue;

    // The pinned stop wins: it is the shop the dispatcher actually sent the
    // rider to, rather than a category string that may predate the pinning.
    let categoryId: number | null = row.pinpoint?.categoryId ?? null;

    if (categoryId == null && row.storeCategory) {
      const tail = row.storeCategory.split(" | ").pop()?.trim().toLowerCase() ?? "";
      categoryId = byName.get(tail)?.id ?? null;
    }
    if (categoryId == null) continue;

    const list = byKey.get(key) ?? [];
    list.push({ errandId: row.errandId, categoryId });
    byKey.set(key, list);
  }

  memoryCache = { at: Date.now(), rows: byKey };
  return byKey;
}

/** Tallies one item's remembered filings, leaving out the errand being asked about. */
function recall(rows: MemoryRow[] | undefined, excludeErrandId: string): MemoryEntry | null {
  if (!rows) return null;
  const entry: MemoryEntry = { byCategory: new Map(), total: 0 };
  for (const row of rows) {
    if (row.errandId === excludeErrandId) continue;
    entry.byCategory.set(row.categoryId, (entry.byCategory.get(row.categoryId) ?? 0) + 1);
    entry.total += 1;
  }
  return entry.total > 0 ? entry : null;
}

/** Drops the cache so a just-sent item list is visible immediately. */
export function forgetMemoryCache(): void {
  memoryCache = null;
}

/**
 * What this errand's pins can actually offer, by category.
 *
 * A category with exactly one pinned shop is an unambiguous placement. With
 * two, the category alone cannot choose between them and the item is left for
 * the dispatcher rather than filed on a coin flip — the same rule stage 3
 * already applies to items that arrive with no shop.
 */
function buildStopIndex(pinpoints: Array<{ id: number; storeName: string; categoryId: number | null }>) {
  const byCategory = new Map<number, Array<{ id: number; storeName: string }>>();
  for (const pin of pinpoints) {
    if (pin.categoryId == null) continue;
    const list = byCategory.get(pin.categoryId) ?? [];
    list.push({ id: pin.id, storeName: pin.storeName });
    byCategory.set(pin.categoryId, list);
  }
  return byCategory;
}

export async function suggestItemPlacements(
  errandId: string,
  names: string[]
): Promise<ItemPlacement[]> {
  const errand = await errandRepository.findById(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");

  const pinpoints = ((errand as any).pinpoints ?? []) as Array<{
    id: number;
    storeName: string;
    categoryId: number | null;
  }>;
  const stopsByCategory = buildStopIndex(pinpoints);

  const [memory, categories] = await Promise.all([
    loadMemory(),
    merchantCategoryRepository.findMany({ includeInactive: false }),
  ]);
  const categoryById = new Map<number, string>(
    categories.map((c: { id: number; name: string }) => [c.id, c.name])
  );

  // Only the names the memory cannot answer reach the model, and they go in a
  // single batched call — stage 3 asks about a whole basket at once.
  const resolved = new Map<number, ItemPlacement>();
  const unknown: Array<{ index: number; name: string }> = [];

  names.forEach((name, index) => {
    const entry = recall(memory.get(itemNameKey(name)), errandId);
    if (!entry || entry.total === 0) {
      unknown.push({ index, name });
      return;
    }

    const [topCategory, count] = [...entry.byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
    const agreement = count / entry.total;
    const categoryName = categoryById.get(topCategory) ?? null;

    if (!categoryName) {
      // Learned a category that has since been deactivated or renamed. Fall
      // through to the model rather than naming something nobody can pick.
      unknown.push({ index, name });
      return;
    }

    resolved.set(index, {
      name,
      categoryId: topCategory,
      categoryName,
      pinpointId: null,
      storeName: null,
      confidence: Number(agreement.toFixed(4)),
      source: "learned",
      learnedFrom: entry.total,
      reason:
        entry.total < PATTERN_MIN_SAMPLES
          ? `A dispatcher filed this under ${categoryName} once before.`
          : agreement >= CONTESTED_AGREEMENT
            ? `Filed under ${categoryName} ${count} of the last ${entry.total} times.`
            : `Past decisions disagree — ${categoryName} ${count} of ${entry.total}. Worth checking.`,
    });
  });

  if (unknown.length > 0) {
    const predictions = await inferItemCategories(unknown.map((u) => u.name));
    unknown.forEach((target, i) => {
      const prediction: any = predictions[i];
      const hasAnswer = prediction?.available && prediction.categoryId != null;
      resolved.set(target.index, {
        name: target.name,
        categoryId: hasAnswer ? prediction.categoryId : null,
        categoryName: hasAnswer ? prediction.categoryName : null,
        pinpointId: null,
        storeName: null,
        confidence: hasAnswer ? prediction.confidence ?? 0 : 0,
        source: hasAnswer ? "model" : "none",
        learnedFrom: 0,
        reason: hasAnswer
          ? "No one has filed this item before, so the name was read."
          : prediction?.reason ?? "Nothing confident to suggest.",
      });
    });
  }

  // Finally, turn each category into one of THIS errand's pins.
  return names.map((_, index) => {
    const placement = resolved.get(index)!;
    if (placement.categoryId == null) return placement;

    const stops = stopsByCategory.get(placement.categoryId) ?? [];
    if (stops.length === 1) {
      return { ...placement, pinpointId: stops[0].id, storeName: stops[0].storeName };
    }
    if (stops.length > 1) {
      return {
        ...placement,
        reason: `${placement.reason} ${stops.length} pinned shops match that category, so pick one.`,
      };
    }
    return {
      ...placement,
      reason: `${placement.reason} No pinned shop matches that category yet.`,
    };
  });
}
