/**
 * Catalog Suggestion Service.
 *
 * Provides item autocomplete suggestions for dispatchers in Stage 3 and customers.
 * Designed with zero price exposure: returns item names, source stores, and categories.
 *
 * Until 2026-09-25 this searched crawled_merchant_items alone. Nothing had ever
 * written a row to that table, so every search in the Catalog Helper came back
 * "No crawled items found". It now merges three sources, each labelled so the
 * console can say where a suggestion came from:
 *
 *   crawled  a store's menu, from a crawl, a flyer read by OCR, or staff
 *   history  the item was bought at that store on a past errand
 *            (pabili_details_tbl, "Store 1 - Kimsan Plaza | Retail & ...")
 *   common   a lexicon item and the kind of shop it is usually bought at, from
 *            the Python category service (never a claim about one store)
 *   predicted  nothing matched, so the item model's guess for the text as typed
 */

import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { searchCommonItems } from "../lib/category/categoryServiceClient.js";

export type CatalogSource = "crawled" | "history" | "common" | "predicted";

export interface CatalogItemSuggestion {
  /** The crawled row's id; negative for the other sources, which have no row. */
  id: number;
  itemName: string;
  /** Empty for "common" and "predicted": those name a kind of shop, not a shop. */
  rawStoreName: string;
  categoryName: string;
  isAvailable: boolean;
  verifiedPlaceId: string | null;
  source: CatalogSource;
  /** "history": how many past order lines bought it at this store. */
  timesOrdered?: number;
  /** "predicted": the item model's confidence. */
  confidence?: number;
}

/**
 * "Store 2 - Julie's Bakeshop | Bakery" -> { store: "Julie's Bakeshop", category: "Bakery" }.
 * Rows written before the console used the composite carry a bare category.
 */
export function splitStoreCategory(raw: string | null | undefined): { store: string; category: string } {
  const value = (raw ?? "").trim();
  const cut = value.lastIndexOf(" | ");
  if (cut < 0) return { store: "", category: value };
  return {
    store: value.slice(0, cut).replace(/^Store\s+\d+\s*-\s*/i, "").trim(),
    category: value.slice(cut + 3).trim(),
  };
}

/** Items bought on past errands whose name contains the query, most-bought first. */
async function searchOrderHistory(query: string, limit: number): Promise<CatalogItemSuggestion[]> {
  const rows = await prisma.pabiliDetail.findMany({
    where: { itemName: { contains: query } },
    select: { itemName: true, storeCategory: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const groups = new Map<string, { itemName: string; store: string; category: string; count: number }>();
  for (const row of rows) {
    const itemName = row.itemName.trim();
    const { store, category } = splitStoreCategory(row.storeCategory);
    if (!itemName || !category) continue;
    const key = `${itemName.toLowerCase()}\u0000${store.toLowerCase()}\u0000${category}`;
    const group = groups.get(key);
    // Rows arrive newest first, so the first spelling kept is the latest one.
    if (group) group.count += 1;
    else groups.set(key, { itemName, store, category, count: 1 });
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g, i) => ({
      id: -(i + 1),
      itemName: g.itemName,
      rawStoreName: g.store,
      categoryName: g.category,
      isAvailable: true,
      verifiedPlaceId: null,
      source: "history" as const,
      timesOrdered: g.count,
    }));
}

/**
 * Searches crawled menus, the order history and the common-item lexicon.
 * Price is explicitly omitted per system design invariants.
 *
 * With `placeId` only that place's crawled menu is searched: the other sources
 * are not tied to a catalogue place. Each source fails on its own; a category
 * service that is down costs the common items, not the whole answer.
 */
export async function searchCatalogItems(
  query: string,
  options?: { placeId?: string; limit?: number }
): Promise<CatalogItemSuggestion[]> {
  const cleanQuery = query.trim();
  if (cleanQuery.length < 2) {
    return [];
  }

  const limit = Math.min(options?.limit ?? 10, 50);

  const [crawled, history, common] = await Promise.all([
    searchCrawledItems(cleanQuery, options?.placeId, limit),
    options?.placeId
      ? Promise.resolve([])
      : searchOrderHistory(cleanQuery, limit).catch((error) => {
          logger.error("[CatalogSuggestion] Error searching order history:", error);
          return [] as CatalogItemSuggestion[];
        }),
    options?.placeId ? Promise.resolve(null) : searchCommonItems(cleanQuery, limit),
  ]);

  // The same item at the same store once; a common item once, and not at all
  // when a crawled menu or the history already names it at a real store.
  const merged: CatalogItemSuggestion[] = [];
  const seen = new Set<string>();
  const named = new Set<string>();
  for (const item of [...crawled, ...history]) {
    const key = `${item.itemName.toLowerCase()}\u0000${item.rawStoreName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    named.add(item.itemName.toLowerCase());
    merged.push(item);
  }
  let nextId = -(history.length + 1);
  for (const item of common?.results ?? []) {
    if (named.has(item.name.toLowerCase())) continue;
    named.add(item.name.toLowerCase());
    merged.push({
      id: nextId--,
      itemName: item.name,
      rawStoreName: "",
      categoryName: item.category,
      isAvailable: true,
      verifiedPlaceId: null,
      source: "common",
    });
  }
  if (merged.length === 0 && common?.prediction) {
    merged.push({
      id: nextId--,
      itemName: common.prediction.name,
      rawStoreName: "",
      categoryName: common.prediction.category,
      isAvailable: true,
      verifiedPlaceId: null,
      source: "predicted",
      confidence: common.prediction.confidence,
    });
  }
  return merged.slice(0, limit);
}

async function searchCrawledItems(
  cleanQuery: string,
  placeId: string | undefined,
  limit: number
): Promise<CatalogItemSuggestion[]> {
  try {
    const items = await prisma.crawledMerchantItem.findMany({
      where: {
        itemName: {
          contains: cleanQuery,
        },
        ...(placeId ? { verifiedPlaceId: placeId } : {}),
        isAvailable: true,
      },
      select: {
        id: true,
        itemName: true,
        rawStoreName: true,
        categoryName: true,
        isAvailable: true,
        verifiedPlaceId: true,
      },
      take: limit,
      orderBy: {
        lastSeenAt: "desc",
      },
    });

    return items.map((item) => ({ ...item, source: "crawled" as const }));
  } catch (error) {
    logger.error("[CatalogSuggestion] Error searching catalog items:", error);
    return [];
  }
}

export class CatalogInputError extends Error {}

export interface CatalogueItemInput {
  itemName: unknown;
  rawStoreName: unknown;
  categoryName: unknown;
  verifiedPlaceId?: unknown;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * Staff cataloguing (sourceType STAFF_CATALOGUED): a dispatcher or owner saves
 * an item against a store so the Catalog Helper finds it next time. Nothing else
 * ever wrote to crawled_merchant_items.
 *
 * Saving the same item at the same store again does not add a row: it refreshes
 * lastSeenAt, brings an item marked unavailable back, and takes the newer
 * category. The category must be a live MerchantCategory, so a category an owner
 * adds or renames needs no change here.
 */
export async function catalogueItem(
  input: CatalogueItemInput
): Promise<{ item: CatalogItemSuggestion; created: boolean }> {
  const itemName = cleanText(input.itemName, 150);
  const rawStoreName = cleanText(input.rawStoreName, 150);
  const categoryName = cleanText(input.categoryName, 80);
  if (itemName.length < 2) throw new CatalogInputError("Item name must be at least 2 characters.");
  if (!rawStoreName) throw new CatalogInputError("Pick the store this item is bought at.");
  if (!categoryName) throw new CatalogInputError("Pick the category of the store.");

  const category = await prisma.merchantCategory.findFirst({
    where: { name: categoryName, status: "Active" },
    select: { name: true },
  });
  if (!category) throw new CatalogInputError(`"${categoryName}" is not an active category.`);

  let verifiedPlaceId: string | null = null;
  if (typeof input.verifiedPlaceId === "string" && input.verifiedPlaceId.trim()) {
    const place = await prisma.verifiedPlace.findUnique({
      where: { id: input.verifiedPlaceId.trim() },
      select: { id: true },
    });
    if (!place) throw new CatalogInputError("That catalogue place no longer exists.");
    verifiedPlaceId = place.id;
  }

  const select = {
    id: true,
    itemName: true,
    rawStoreName: true,
    categoryName: true,
    isAvailable: true,
    verifiedPlaceId: true,
  } as const;

  // MariaDB's default collation is case-insensitive, so equals matches "pandesal"
  // to "Pandesal" without a lower() on either side.
  const existing = await prisma.crawledMerchantItem.findFirst({
    where: { itemName, rawStoreName },
    select: { id: true },
  });
  if (existing) {
    const row = await prisma.crawledMerchantItem.update({
      where: { id: existing.id },
      data: {
        categoryName: category.name,
        isAvailable: true,
        lastSeenAt: new Date(),
        ...(verifiedPlaceId ? { verifiedPlaceId } : {}),
      },
      select,
    });
    return { item: { ...row, source: "crawled" }, created: false };
  }

  const row = await prisma.crawledMerchantItem.create({
    data: {
      itemName,
      rawStoreName,
      categoryName: category.name,
      verifiedPlaceId,
      sourceType: "STAFF_CATALOGUED",
    },
    select,
  });
  return { item: { ...row, source: "crawled" }, created: true };
}

/**
 * Takes an item out of the Catalog Helper. The row is kept, marked unavailable,
 * so cataloguing it again brings it back rather than starting over.
 */
export async function retireCatalogItem(id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await prisma.crawledMerchantItem.updateMany({
    where: { id },
    data: { isAvailable: false },
  });
  return result.count > 0;
}

/**
 * Lists available menu items associated with a specific verified establishment.
 */
export async function listItemsForPlace(
  placeId: string,
  limit = 50
): Promise<CatalogItemSuggestion[]> {
  try {
    const items = await prisma.crawledMerchantItem.findMany({
      where: {
        verifiedPlaceId: placeId,
        isAvailable: true,
      },
      select: {
        id: true,
        itemName: true,
        rawStoreName: true,
        categoryName: true,
        isAvailable: true,
        verifiedPlaceId: true,
      },
      take: limit,
      orderBy: {
        itemName: "asc",
      },
    });

    return items.map((item) => ({ ...item, source: "crawled" as const }));
  } catch (error) {
    logger.error(`[CatalogSuggestion] Error listing items for place ${placeId}:`, error);
    return [];
  }
}
