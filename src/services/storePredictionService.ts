import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/prisma.js";
import { haversineDistanceKm, type GeoPoint } from "../lib/geo.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "./ServiceError.js";
import { itemNameKey } from "./patterns/itemNameKey.js";
import { suggestItemPlacements, type ItemPlacement } from "./itemPlacementService.js";
import { checkStoreLocation, type StoreLocationVerdict } from "./storeLocationGuard.js";
import { bindRoles, resolveCategoryLabel } from "./categoryRoles.js";

/**
 * Which stores to pin, predicted from the item list.
 *
 * Step 1 of the dispatcher console settles WHAT the customer wants; step 3
 * pins WHERE it is bought. Until now the dispatcher answered the second
 * question from memory on every order, even though the system already held
 * every answer a dispatcher had given before. This reads those answers back.
 *
 * ## What it learns from
 *
 * Nothing new is collected. Two things the console already writes are the
 * training data:
 *
 * 1. **Filings.** When a dispatcher confirms the items (step 4), each item is
 *    written to `pabili_details_tbl` against the pinned stop it will be bought
 *    at. That is a labelled example: this item, this store. Only filings made
 *    by the console count, marked by the "Store N - Name | Category" form, for
 *    the reasons itemPlacementService documents.
 * 2. **Pins.** Every store ever pinned, with its coordinates and category.
 *    Grouped by name and location, they form a directory of the stores this
 *    operation actually uses. Production has no verified-place catalogue yet
 *    (0 rows on 2026-09-23), so this directory is the catalogue.
 * 3. **The map.** Tacurong's named shops from OpenStreetMap, each filed under
 *    a category by the category service or by the mappers' own tag
 *    (server/ml/crawler, data/tacurong_places_review.csv). Added 2026-09-25:
 *    until then a kind of shop nobody had pinned before had nothing to
 *    propose at all. They join the directory unused, like catalogue places, so
 *    a store dispatchers actually use still outranks them; among the unused,
 *    the one nearest the customer comes first.
 *
 * A correction is therefore learned the moment it is saved: when the
 * dispatcher answers "not accurate", pins the right store and files the items
 * under it, the next prediction for those items sees it, because the cache is
 * dropped on every filing and every pin save.
 *
 * ## How it predicts, per item, best evidence first
 *
 * - **named**: the item names the store itself ("Jolibee bucket chicken",
 *   "Mercury biogesic"). Customers write the brand in as often as not, and a
 *   one-letter misspelling is tolerated, because that is how it arrives.
 * - **learned**: dispatchers bought this exact item (by `itemNameKey`) at a
 *   store before. Scored by share of past filings, recency-weighted, and
 *   discounted when there are few of them.
 * - **similar**: nobody bought this exact item, but items sharing most of its
 *   words were bought somewhere (token overlap, a nearest-neighbour vote).
 * - **category**: the item's category is known (learned, or read by the
 *   Python classifier in server/ml), so the most-used store in that category,
 *   nearest the customer, is proposed.
 *
 * The stores are then chosen as a set: greedily, the store that covers the
 * most of the remaining list goes first, up to the three-stop limit. A basket
 * of medicine and bread becomes one pharmacy and one bakery, not three
 * pharmacies that each stock one item.
 *
 * Every proposed store passes the same location guard as a manual pin: one
 * off the road map is never proposed, and one past the border carries the
 * warning.
 */

/** The same three-stop limit the pinpoint validator enforces. */
const MAX_STORES = 3;

/** Past filings lose half their weight every this many days. */
const HALF_LIFE_DAYS = 45;

/** A store must score at least this for an item to count as covering it. */
const MIN_ITEM_SCORE = 0.15;

/** Word overlap needed before a different item's history is borrowed. */
const MIN_SIMILARITY = 0.5;

/** Borrowed history counts for less than the item's own. */
const SIMILAR_DISCOUNT = 0.7;

/** An item that names a store we know is about as strong as evidence gets. */
const NAMED_SCORE = 0.85;

/**
 * Words in a store name that say what KIND of shop it is, not which one.
 * Matching on these would send every "bread" item to every "bakery".
 */
const GENERIC_STORE_WORDS = new Set([
  "store", "stores", "shop", "supermarket", "super", "market", "mart", "mall", "grocery",
  "pharmacy", "drug", "drugstore", "bakeshop", "bakery", "bakeshoppe", "cafe", "coffee",
  "restaurant", "resto", "food", "foods", "center", "centre", "plaza", "branch", "city",
  "the", "and", "of", "dt", "drive", "thru", "express", "trading", "enterprises", "inc",
  "corp", "hardware", "general", "merchandise", "house", "kitchen", "grill", "eatery",
  "unnamed", "road", "street", "national", "highway",
]);

/** Levenshtein distance, bailing out once it passes 1: only 0 or 1 matter here. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The words of a store name that identify it: "jollibee" in "Jollibee Tacurong DT". */
const brandTokens = (normalizedName: string) =>
  normalizedName.split(" ").filter((t) => t.length >= 4 && !GENERIC_STORE_WORDS.has(t) && !/^\d+$/.test(t));

/**
 * Whether an item word names this brand word. A typo is allowed only on longer
 * words, and never in the first letter: "jolibee" is Jollibee, but "paint" is
 * not "Saint Louis Hospital", which it was one edit from once the map's shop
 * names joined the directory.
 */
const namesBrand = (itemToken: string, brand: string) =>
  itemToken === brand ||
  (brand.length >= 5 && itemToken.length >= 5 && itemToken[0] === brand[0] && withinOneEdit(itemToken, brand));

/** Knowing the category is weaker evidence than knowing the store. */
const CATEGORY_DISCOUNT = 0.6;

/** Two pins of one store this close together are the same store. */
const SAME_STORE_METERS = 150;

const MEMORY_TTL_MS = 60_000;
const PIN_ROW_LIMIT = 3000;
const FILING_ROW_LIMIT = 4000;

export type PredictionSource = "named" | "learned" | "similar" | "category";

export interface PredictedStore {
  storeName: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  categoryId: number | null;
  categoryName: string | null;
  /** The items on this order this store is proposed for. */
  items: string[];
  /** 0-1. The mean score of the items it covers. */
  confidence: number;
  source: PredictionSource;
  /** Past dispatcher filings behind the answer. 0 for a category guess. */
  learnedFrom: number;
  reason: string;
  location: StoreLocationVerdict;
  /** Already one of this errand's pins. */
  alreadyPinned: boolean;
}

export interface StorePrediction {
  stores: PredictedStore[];
  uncovered: Array<{ name: string; reason: string }>;
  /** Filings the memory currently holds, so the UI can be honest about it. */
  trainingExamples: number;
}

// ── the learned directory and memory ────────────────────────────────────────

/** Where a directory entry was first known from, which the reason names. */
type DirectoryOrigin = "pins" | "catalogue" | "map";

interface DirectoryEntry {
  key: string;
  normalizedName: string;
  storeName: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  categoryId: number | null;
  /** Recency-weighted count of pins. */
  uses: number;
  origin: DirectoryOrigin;
}

interface Filing {
  errandId: string;
  storeKey: string;
  weight: number;
}

interface Memory {
  directory: Map<string, DirectoryEntry>;
  byName: Map<string, DirectoryEntry[]>;
  filings: Map<string, Filing[]>;
  filingCount: number;
}

let memoryCache: { at: number; memory: Memory } | null = null;

/**
 * Drop the cache so a pin or filing just saved is learned at once. The crawled
 * places are re-read too (a few kilobytes), so a fresh crawl needs no restart.
 */
export function forgetStorePredictionMemory(): void {
  memoryCache = null;
  crawledPlaces = null;
}

const JUNK_NAMES = /^(unnamed road|unnamed|store \d+|pinned location|dropped pin|location)$/;

/**
 * The part of a store name two dispatchers would agree on.
 *
 * Google names arrive with the address glued on ("Julie's Bakeshop
 * Mabini-Dona Alicia, Poblacion, Tacurong") and branches carry the city
 * ("NCCC Supermarket Tacurong City"). Both are cut, so repeat pins of one
 * shop meet under one key.
 */
export function normalizeStoreName(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw)
    .toLowerCase()
    .split(",")[0]
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\b(tacurong( city)?|sultan kudarat)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ageWeight = (createdAt: Date | string | null | undefined, now: number): number => {
  if (!createdAt) return 1;
  const days = Math.max(0, (now - new Date(createdAt).getTime()) / 86_400_000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
};

const metres = (a: GeoPoint, b: GeoPoint) => haversineDistanceKm(a, b) * 1000;

function findEntry(byName: Map<string, DirectoryEntry[]>, name: string, point: GeoPoint) {
  return byName.get(name)?.find((e) => metres(e, point) <= SAME_STORE_METERS) ?? null;
}

function upsertEntry(
  memory: Pick<Memory, "directory" | "byName">,
  pin: { storeName: string; latitude: number; longitude: number; placeId: string | null; categoryId: number | null },
  weight: number,
  origin: DirectoryOrigin = "pins"
): DirectoryEntry | null {
  const normalizedName = normalizeStoreName(pin.storeName);
  if (!normalizedName || JUNK_NAMES.test(normalizedName)) return null;
  if (!Number.isFinite(pin.latitude) || !Number.isFinite(pin.longitude)) return null;

  const existing = findEntry(memory.byName, normalizedName, pin);
  if (existing) {
    existing.uses += weight;
    // A place from the map or the catalogue that has since been pinned is a
    // store this operation uses.
    if (origin === "pins") existing.origin = "pins";
    // Rows arrive newest first, so the first values seen are kept; later
    // (older) rows only fill in what is still missing.
    existing.placeId ??= pin.placeId;
    existing.categoryId ??= pin.categoryId;
    return existing;
  }

  const entry: DirectoryEntry = {
    key: `${normalizedName}@${pin.latitude.toFixed(4)},${pin.longitude.toFixed(4)}`,
    normalizedName,
    storeName: pin.storeName.split(",")[0].trim(),
    latitude: pin.latitude,
    longitude: pin.longitude,
    placeId: pin.placeId,
    categoryId: pin.categoryId,
    uses: weight,
    origin,
  };
  memory.directory.set(entry.key, entry);
  const list = memory.byName.get(normalizedName) ?? [];
  list.push(entry);
  memory.byName.set(normalizedName, list);
  return entry;
}

// ── the map: Tacurong establishments from the OpenStreetMap crawl ──────────

const CRAWLED_PLACES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../ml/data/tacurong_places_review.csv"
);

export interface CrawledPlace {
  storeName: string;
  latitude: number;
  longitude: number;
  categoryName: string;
}

/** One CSV record per line, quoted fields allowed ("Julie's Bakeshop, Poblacion"). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * The review sheet crawler.run writes, reduced to the places worth proposing.
 *
 * A place is kept when a mapper tagged its kind (a person said what it is) or
 * the store model filed it at 0.75 or above without needing review. The
 * mapper's tag wins where both exist. Rows with no position are dropped: a
 * store the rider cannot be routed to is no suggestion.
 */
export function parseCrawledPlaces(csv: string): CrawledPlace[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const col = (name: string) => header.indexOf(name);
  const [iName, iLat, iLon, iMapper, iFinal, iReview] = [
    col("name"), col("lat"), col("lon"), col("mapper_category"), col("final_category"), col("needs_review"),
  ];
  if ([iName, iLat, iLon, iMapper, iFinal, iReview].some((i) => i < 0)) return [];

  const places: CrawledPlace[] = [];
  for (const line of lines.slice(1)) {
    const row = parseCsvLine(line);
    // Empty is missing, not zero: Number("") is 0, a real coordinate off Africa.
    const latitude = (row[iLat] || "").trim() ? Number(row[iLat]) : NaN;
    const longitude = (row[iLon] || "").trim() ? Number(row[iLon]) : NaN;
    const mapper = (row[iMapper] || "").trim();
    const categoryName = mapper || (row[iReview] === "no" ? (row[iFinal] || "").trim() : "");
    const storeName = (row[iName] || "").trim();
    if (!storeName || !categoryName || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    places.push({ storeName, latitude, longitude, categoryName });
  }
  return places;
}

let crawledPlaces: CrawledPlace[] | null = null;

async function loadCrawledPlaces(): Promise<CrawledPlace[]> {
  if (crawledPlaces) return crawledPlaces;
  try {
    crawledPlaces = parseCrawledPlaces(await readFile(CRAWLED_PLACES_PATH, "utf8"));
    logger.info(`Store prediction: ${crawledPlaces.length} Tacurong places from the OpenStreetMap crawl.`);
  } catch {
    // No crawl on this install: the directory is pins and catalogue, as before.
    crawledPlaces = [];
  }
  return crawledPlaces;
}

async function loadMemory(): Promise<Memory> {
  if (memoryCache && Date.now() - memoryCache.at < MEMORY_TTL_MS) return memoryCache.memory;

  const now = Date.now();
  const [pins, places, filings, crawled, categories] = await Promise.all([
    prisma.errandPinpoint.findMany({
      select: { storeName: true, latitude: true, longitude: true, placeId: true, categoryId: true, createdAt: true },
      orderBy: { id: "desc" },
      take: PIN_ROW_LIMIT,
    }),
    prisma.verifiedPlace.findMany({
      where: { isActive: true },
      select: { id: true, name: true, latitude: true, longitude: true, categoryId: true },
    }),
    prisma.pabiliDetail.findMany({
      where: { itemName: { not: "" }, storeCategory: { contains: " | " }, pinpointId: { not: null } },
      select: {
        errandId: true,
        itemName: true,
        createdAt: true,
        pinpoint: {
          select: { storeName: true, latitude: true, longitude: true, placeId: true, categoryId: true },
        },
      },
      orderBy: { id: "desc" },
      take: FILING_ROW_LIMIT,
    }),
    loadCrawledPlaces(),
    prisma.merchantCategory.findMany({
      where: { status: "Active" },
      select: { id: true, name: true, description: true },
    }),
  ]);

  const memory: Memory = { directory: new Map(), byName: new Map(), filings: new Map(), filingCount: 0 };

  for (const pin of pins) upsertEntry(memory, pin, ageWeight(pin.createdAt, now));
  // The catalogue joins with no usage of its own: it can be proposed for its
  // category, but a store dispatchers actually use outranks it.
  for (const place of places) {
    upsertEntry(
      memory,
      { storeName: place.name, latitude: place.latitude, longitude: place.longitude, placeId: place.id, categoryId: place.categoryId },
      0,
      "catalogue"
    );
  }
  // The map, last and unused: it can fill a category nobody has pinned, and
  // never outranks a store that has actually been used.
  // The sheet names categories as they were called when the map was read.
  // Through the roles (categoryRoles.ts) a mapped bakery still finds the
  // bakery category after it is renamed "Breads & Pastries"; matched by exact
  // name alone, every mapped bakery silently dropped out of the suggestions.
  const categoryIdByName = new Map(categories.map((c) => [c.name, c.id]));
  const roleBinding = bindRoles(categories);
  for (const place of crawled) {
    const live = resolveCategoryLabel(place.categoryName, categories, roleBinding);
    const categoryId = live ? categoryIdByName.get(live) : undefined;
    if (categoryId == null) continue; // a category this catalogue does not have (or retired)
    upsertEntry(
      memory,
      { storeName: place.storeName, latitude: place.latitude, longitude: place.longitude, placeId: null, categoryId },
      0,
      "map"
    );
  }

  for (const row of filings) {
    if (!row.pinpoint) continue;
    const key = itemNameKey(row.itemName);
    if (!key) continue;
    // The pin itself is already counted above; this only resolves which
    // directory entry it belongs to.
    const entry = upsertEntry(memory, row.pinpoint, 0);
    if (!entry) continue;
    const list = memory.filings.get(key) ?? [];
    list.push({ errandId: row.errandId, storeKey: entry.key, weight: ageWeight(row.createdAt, now) });
    memory.filings.set(key, list);
    memory.filingCount += 1;
  }

  memoryCache = { at: now, memory };
  return memory;
}

// ── scoring ────────────────────────────────────────────────────────────────

interface Candidate {
  score: number;
  source: PredictionSource;
  learnedFrom: number;
  reason: string;
}

const tokens = (key: string) => new Set(key.split(" ").filter((t) => t.length > 1));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** n past filings are worth n/(n+1): one is a hint, a dozen is a habit. */
const strength = (n: number) => n / (n + 1);

function votesFor(filings: Filing[] | undefined, errandId: string) {
  const byStore = new Map<string, { weight: number; count: number }>();
  let total = 0;
  let count = 0;
  for (const f of filings ?? []) {
    // An errand never learns from its own filings: it would only echo itself.
    if (f.errandId === errandId) continue;
    const slot = byStore.get(f.storeKey) ?? { weight: 0, count: 0 };
    slot.weight += f.weight;
    slot.count += 1;
    byStore.set(f.storeKey, slot);
    total += f.weight;
    count += 1;
  }
  return { byStore, total, count };
}

function candidatesForItem(
  name: string,
  errandId: string,
  memory: Memory,
  placement: ItemPlacement | undefined,
  delivery: GeoPoint | null,
  directoryByCategory: Map<number, DirectoryEntry[]>
): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  const offer = (storeKey: string, candidate: Candidate) => {
    const current = out.get(storeKey);
    if (!current || current.score < candidate.score) out.set(storeKey, candidate);
  };

  const key = itemNameKey(name);

  // 0. The item names a store we know. Nearest branch first.
  const itemTokens = key.split(" ").filter((t) => t.length >= 4);
  if (itemTokens.length > 0) {
    // Stores dispatchers used and the catalogue only. A mapped name is any
    // word someone typed into OpenStreetMap ("Saint", "Family", a person's
    // name), and matching items against a hundred of them finds brands that
    // were never there. The map still answers through the category, below.
    const named = [...memory.directory.values()]
      .filter((store) => store.origin !== "map")
      .filter((store) => brandTokens(store.normalizedName).some((b) => itemTokens.some((t) => namesBrand(t, b))))
      .map((store) => ({ store, km: delivery ? haversineDistanceKm(delivery, store) : 0 }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 2);
    named.forEach(({ store }, rank) => {
      offer(store.key, {
        // The farther branch stays a candidate, a step down, in case the
        // nearest one is later blocked by the location guard.
        score: rank === 0 ? NAMED_SCORE : NAMED_SCORE * 0.8,
        source: "named",
        learnedFrom: 0,
        reason: `"${name}" names ${store.storeName}.`,
      });
    });
  }

  // 1. This exact item's own history.
  const own = votesFor(memory.filings.get(key), errandId);
  if (own.total > 0) {
    for (const [storeKey, slot] of own.byStore) {
      const share = slot.weight / own.total;
      const store = memory.directory.get(storeKey)!;
      offer(storeKey, {
        score: share * strength(own.count),
        source: "learned",
        learnedFrom: slot.count,
        reason:
          own.count === 1
            ? `A dispatcher bought ${name} at ${store.storeName} once before.`
            : `${name} was bought here ${slot.count} of the last ${own.count} times.`,
      });
    }
  }

  // 2. Items that share most of their words, when this one has no history.
  if (own.total === 0 && key) {
    const mine = tokens(key);
    for (const [otherKey, filings] of memory.filings) {
      const similarity = jaccard(mine, tokens(otherKey));
      if (similarity < MIN_SIMILARITY) continue;
      const votes = votesFor(filings, errandId);
      if (votes.total === 0) continue;
      for (const [storeKey, slot] of votes.byStore) {
        const store = memory.directory.get(storeKey)!;
        offer(storeKey, {
          score: (slot.weight / votes.total) * strength(votes.count) * similarity * SIMILAR_DISCOUNT,
          source: "similar",
          learnedFrom: slot.count,
          reason: `Similar items ("${otherKey}") were bought at ${store.storeName}.`,
        });
      }
    }
  }

  // 3. The item's category, then the most-used store of that kind nearby.
  if (placement?.categoryId != null) {
    const pool = directoryByCategory.get(placement.categoryId) ?? [];
    const ranked = pool
      .map((store) => {
        const km = delivery ? haversineDistanceKm(delivery, store) : null;
        // Usage dominates, distance breaks ties and demotes the far branch.
        const value = Math.log1p(store.uses + 0.25) / (1 + (km ?? 0) / 3);
        return { store, km, value };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, 2);
    const best = ranked[0]?.value ?? 0;
    for (const { store, km, value } of ranked) {
      if (best <= 0) break;
      const categoryName = placement.categoryName ?? "this kind of";
      // Said as what it is: "used most" only of a store that has been used.
      const what =
        store.origin === "pins"
          ? `is the ${categoryName} store used most`
          : store.origin === "catalogue"
            ? `is a ${categoryName} store in the catalogue`
            : `is a ${categoryName} place on the map (OpenStreetMap)`;
      offer(store.key, {
        score: placement.confidence * CATEGORY_DISCOUNT * (value / best),
        source: "category",
        learnedFrom: 0,
        reason:
          `${name} reads as ${categoryName}. ${store.storeName} ${what}` +
          (km !== null ? `, ${km < 10 ? km.toFixed(1) : Math.round(km)} km from the customer.` : "."),
      });
    }
  }

  return out;
}

// ── the prediction ─────────────────────────────────────────────────────────

export async function predictStores(errandId: string, names?: string[]): Promise<StorePrediction> {
  const errand = await prisma.errand.findUnique({
    where: { id: errandId },
    select: {
      id: true,
      deliveryLatitude: true,
      deliveryLongitude: true,
      pinpoints: { select: { storeName: true, latitude: true, longitude: true } },
      pabiliDetails: { select: { itemName: true } },
      pabiliItemRequests: { select: { itemName: true } },
    },
  });
  if (!errand) throw new ServiceError(404, "Errand not found");

  // The step 1 list as the screen holds it when sent, else as last saved.
  const itemNames = (
    names && names.length > 0
      ? names
      : (errand.pabiliDetails.length > 0 ? errand.pabiliDetails : errand.pabiliItemRequests).map((i) => i.itemName)
  )
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  const uniqueNames = [...new Set(itemNames)];

  const memory = await loadMemory();
  if (uniqueNames.length === 0) {
    return { stores: [], uncovered: [], trainingExamples: memory.filingCount };
  }

  const delivery =
    errand.deliveryLatitude != null && errand.deliveryLongitude != null
      ? { latitude: Number(errand.deliveryLatitude), longitude: Number(errand.deliveryLongitude) }
      : null;

  // Categories for the fallback route: learned first, then the classifier.
  // A sidecar outage only removes that route; learned answers still come back.
  let placements: ItemPlacement[] = [];
  try {
    placements = await suggestItemPlacements(errandId, uniqueNames);
  } catch (error) {
    logger.warn(`Store prediction for ${errandId}: category lookup failed, using history only.`, error);
  }

  const directoryByCategory = new Map<number, DirectoryEntry[]>();
  for (const entry of memory.directory.values()) {
    if (entry.categoryId == null) continue;
    const list = directoryByCategory.get(entry.categoryId) ?? [];
    list.push(entry);
    directoryByCategory.set(entry.categoryId, list);
  }

  const perItem = uniqueNames.map((name, index) => ({
    name,
    placement: placements[index],
    candidates: candidatesForItem(name, errandId, memory, placements[index], delivery, directoryByCategory),
  }));

  // Every candidate store passes the pin guard once; a blocked one is dropped
  // from every item before selection, so it can never be proposed.
  const verdicts = new Map<string, StoreLocationVerdict>();
  const allKeys = new Set(perItem.flatMap((item) => [...item.candidates.keys()]));
  await Promise.all(
    [...allKeys].map(async (key) => {
      const store = memory.directory.get(key)!;
      verdicts.set(key, await checkStoreLocation(store));
    })
  );
  for (const item of perItem) {
    for (const key of [...item.candidates.keys()]) {
      if (verdicts.get(key)?.status === "blocked") item.candidates.delete(key);
    }
  }

  // Greedy set cover: the store that serves the most of what is left, first.
  const remaining = new Set(perItem.map((_, i) => i));
  const chosen: PredictedStore[] = [];
  const categoryNames = new Map<number, string>(
    (await prisma.merchantCategory.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name])
  );

  // One branch of a chain per proposal: two Mercury Drugs would be a second
  // stop (and a multi-store fee) for nothing the first could not supply.
  const chosenNames = new Set<string>();

  while (chosen.length < MAX_STORES && remaining.size > 0) {
    let bestKey: string | null = null;
    let bestGain = 0;
    for (const key of allKeys) {
      if (chosenNames.has(memory.directory.get(key)!.normalizedName)) continue;
      let gain = 0;
      for (const i of remaining) {
        const score = perItem[i].candidates.get(key)?.score ?? 0;
        if (score >= MIN_ITEM_SCORE) gain += score;
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestKey = key;
      }
    }
    if (!bestKey) break;

    const store = memory.directory.get(bestKey)!;
    const covered: Array<{ name: string; candidate: Candidate }> = [];
    for (const i of [...remaining]) {
      const candidate = perItem[i].candidates.get(bestKey);
      if (candidate && candidate.score >= MIN_ITEM_SCORE) {
        covered.push({ name: perItem[i].name, candidate });
        remaining.delete(i);
      }
    }
    allKeys.delete(bestKey);
    chosenNames.add(store.normalizedName);

    const strongest = covered.reduce((a, b) => (b.candidate.score > a.candidate.score ? b : a));
    const confidence = covered.reduce((sum, c) => sum + c.candidate.score, 0) / covered.length;
    const learnedFrom = covered.reduce((sum, c) => sum + c.candidate.learnedFrom, 0);
    const sources = new Set(covered.map((c) => c.candidate.source));
    const source: PredictionSource = sources.has("named")
      ? "named"
      : sources.has("learned")
        ? "learned"
        : sources.has("similar")
          ? "similar"
          : "category";

    chosen.push({
      storeName: store.storeName,
      latitude: store.latitude,
      longitude: store.longitude,
      placeId: store.placeId,
      categoryId: store.categoryId,
      categoryName: store.categoryId != null ? categoryNames.get(store.categoryId) ?? null : null,
      items: covered.map((c) => c.name),
      confidence: Number(confidence.toFixed(4)),
      source,
      learnedFrom,
      reason:
        covered.length > 1
          ? `${strongest.candidate.reason} Also covers ${covered.length - 1} more item${covered.length > 2 ? "s" : ""} on this list.`
          : strongest.candidate.reason,
      location: verdicts.get(bestKey)!,
      alreadyPinned: errand.pinpoints.some(
        (pin) =>
          normalizeStoreName(pin.storeName) === store.normalizedName &&
          metres({ latitude: pin.latitude, longitude: pin.longitude }, store) <= SAME_STORE_METERS
      ),
    });
  }

  const uncovered = [...remaining].map((i) => {
    const { name, placement, candidates } = perItem[i];
    const known = placement?.categoryId != null ? directoryByCategory.get(placement.categoryId)?.length ?? 0 : 0;
    // It had a store, but the rest of the list took all three stops first.
    const crowdedOut =
      chosen.length >= MAX_STORES && [...candidates.values()].some((c) => c.score >= MIN_ITEM_SCORE);
    const reason = crowdedOut
      ? `${MAX_STORES} stores is the most one errand can have, and the rest of the list needs them. Pin one by hand if this item needs its own.`
      : placement?.categoryName == null
        ? "No past orders and no confident category to go on yet."
        : known === 0
          ? `Reads as ${placement.categoryName}, but no ${placement.categoryName} store has been pinned or mapped yet, so there is nothing to propose.`
          : `Reads as ${placement.categoryName}, but not confidently enough to pick a store for it.`;
    return { name, reason };
  });

  return { stores: chosen, uncovered, trainingExamples: memory.filingCount };
}
