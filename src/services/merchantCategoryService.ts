import { merchantCategoryRepository } from "../repositories/merchantCategoryRepository.js";
import { ServiceError } from "./ServiceError.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { findBlockedCategoryTerm, isPabiliCategoryName } from "../lib/blockedCategoryNames.js";
import { triggerCategoryAutoLearning } from "./categoryRetrainingService.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type {
  CreateMerchantCategoryInput,
  UpdateMerchantCategoryInput,
  StoreCategoryImageUploadInput,
} from "../validators/merchantCategoryValidators.js";

function getCategoryBaseWeight(name: string): number {
  const lower = name.toLowerCase();
  if (lower.includes("fast food") || lower.includes("fastfood")) return 100;
  if (lower.includes("pharmacy") || lower.includes("health") || lower.includes("drug")) return 95;
  if (lower.includes("supermarket") || lower.includes("grocery")) return 90;
  if (lower.includes("bakery") || lower.includes("bread") || lower.includes("pastr")) return 85;
  if (lower.includes("cafe") || lower.includes("coffee")) return 80;
  if (lower.includes("convenience")) return 75;
  if (lower.includes("restaurant") || lower.includes("food")) return 70;
  if (lower.includes("retail") || lower.includes("merchandise")) return 65;
  return 50;
}

export async function listMerchantCategories(
  includeInactive = false,
  customerId?: number | null
) {
  const categories = await merchantCategoryRepository.findMany({ includeInactive });
  if (includeInactive) return categories;

  // Non-Pabili categories (Schools, Banks, Padala Outlets, Motor Trades, etc.)
  // are strictly excluded from the customer app's category catalogue.
  const pabiliCategories = categories.filter((c) => isPabiliCategoryName(c.name));

  // Tally customer's personal category orders
  const personalCategoryCounts = new Map<number, number>();
  if (customerId) {
    try {
      const pins = await prisma.errandPinpoint.findMany({
        where: {
          errand: { customerId, status: { not: "CANCELLED" } },
        },
        select: {
          placeId: true,
          place: { select: { categoryId: true } },
          storeName: true,
        },
        take: 100,
      });

      for (const pin of pins) {
        let catId = pin.place?.categoryId;
        if (!catId && pin.storeName) {
          const lowerStore = pin.storeName.toLowerCase();
          const matched = pabiliCategories.find((cat) => {
            const lowerCat = cat.name.toLowerCase();
            return (
              lowerStore.includes(lowerCat) ||
              (lowerCat.includes("pharmacy") && (lowerStore.includes("pharmacy") || lowerStore.includes("drug"))) ||
              (lowerCat.includes("fast food") && (lowerStore.includes("jollibee") || lowerStore.includes("mcdonald") || lowerStore.includes("chowking") || lowerStore.includes("kfc"))) ||
              (lowerCat.includes("bakery") && (lowerStore.includes("bakery") || lowerStore.includes("bakeshop") || lowerStore.includes("bread"))) ||
              (lowerCat.includes("supermarket") && (lowerStore.includes("supermarket") || lowerStore.includes("grocery") || lowerStore.includes("savemore") || lowerStore.includes("mart")))
            );
          });
          if (matched) catId = matched.id;
        }
        if (catId) {
          personalCategoryCounts.set(catId, (personalCategoryCounts.get(catId) ?? 0) + 1);
        }
      }
    } catch (err: any) {
      logger.warn(`Could not load customer category order history: ${err?.message ?? err}`);
    }
  }

  // Tally platform popularity from recent non-cancelled pins
  const platformCategoryCounts = new Map<number, number>();
  try {
    const platformPins = await prisma.errandPinpoint.findMany({
      where: {
        errand: { status: { not: "CANCELLED" } },
        placeId: { not: null },
      },
      select: {
        place: { select: { categoryId: true } },
      },
      take: 200,
    });
    for (const r of platformPins) {
      if (r.place?.categoryId) {
        platformCategoryCounts.set(
          r.place.categoryId,
          (platformCategoryCounts.get(r.place.categoryId) ?? 0) + 1
        );
      }
    }
  } catch {
    // Graceful fallback to places count and base weight
  }

  // Compute composite score for each category:
  // - Personal orders (+500) vault frequented categories to the top positions
  // - Platform orders (+10) and places (+5) rank city-wide popularity
  // - Base weight (50-100) sets cold-start staple ordering for new accounts
  const categoryScores = new Map<number, number>();
  for (const cat of pabiliCategories) {
    const personalOrders = personalCategoryCounts.get(cat.id) ?? 0;
    const platformOrders = platformCategoryCounts.get(cat.id) ?? 0;
    const placesCount = (cat as any)._count?.places ?? 0;
    const baseWeight = getCategoryBaseWeight(cat.name);
    const score = personalOrders * 500 + platformOrders * 10 + placesCount * 5 + baseWeight;
    categoryScores.set(cat.id, score);
  }

  const sorted = [...pabiliCategories].sort((a, b) => {
    const scoreA = categoryScores.get(a.id) ?? 0;
    const scoreB = categoryScores.get(b.id) ?? 0;
    return scoreB - scoreA || a.name.localeCompare(b.name);
  });

  // Top 4 categories are stamped as recommended
  return sorted.map((cat, index) => {
    const personalOrders = personalCategoryCounts.get(cat.id) ?? 0;
    return {
      ...cat,
      isRecommended: index < 4,
      orderedBefore: personalOrders > 0,
      orderCount: personalOrders,
    };
  });
}

// The catalogue is public to every signed-in client, so a global broadcast is
// the right scope here — unlike the errand events, this payload names no person
// and carries no location.
//
// The payload is deliberately just a signal, not the new row. Clients re-fetch
// through the endpoint they already use, which applies the active-only filter
// server-side; pushing the row itself would mean teaching every consumer to
// re-implement that filter, and getting it wrong is exactly how a deactivated
// category stays on screen.
function announceCatalogueChange(reason: string, categoryId?: number) {
  eventPublisher.emit("merchant-category:changed", { reason, categoryId, at: new Date().toISOString() });
}

/**
 * Refuses a name that describes a bills-payment outlet.
 *
 * Bills payment is not a service this system offers — a rider cannot settle
 * someone's electricity account — so a category for it would put an
 * unfulfillable option in front of the customer. Until now the only guard was
 * the seeder, which deactivates such categories on its next run: an owner could
 * create one through the portal and it would stay live until then.
 *
 * The message names the matched term deliberately. Over-blocking is the worse
 * failure of the two, so an owner who trips this must be able to see exactly
 * which word did it rather than being stuck guessing.
 */
function assertCategoryNameAllowed(name: string | undefined) {
  if (!name) return;

  const blocked = findBlockedCategoryTerm(name);
  if (!blocked) return;

  throw new ServiceError(
    400,
    `"${name}" cannot be used: it contains "${blocked.term}" (${blocked.language}), which is ` +
      `reserved because bills payment is not a service this system offers — it handles Pabili ` +
      `errands only. Choose a name that describes a store a rider can buy from.`
  );
}

export async function createMerchantCategory(input: CreateMerchantCategoryInput) {
  assertCategoryNameAllowed(input.name);

  const category = await merchantCategoryRepository.create(input);
  announceCatalogueChange("created", category.id);
  triggerCategoryAutoLearning({ reason: "created", categoryId: category.id });
  return category;
}

export async function updateMerchantCategory(id: number, input: UpdateMerchantCategoryInput) {
  const existing = await merchantCategoryRepository.findById(id);
  if (!existing) {
    throw new ServiceError(404, "Merchant category not found");
  }

  // Renaming an existing category into a blocked name is the same hole as
  // creating one, so it gets the same guard.
  assertCategoryNameAllowed(input.name);

  const category = await merchantCategoryRepository.update(id, input);

  // A rename has to reach every place that stores the category by NAME, or
  // what was learned under the old name is cut loose: filed items (the
  // "Store 1 - Julie's | Bakery" text), the customer's original picks, and
  // crawled catalogue items. Handling-fee modes and revenue allocation read
  // the same text. Pins and verified places are linked by id and follow on
  // their own.
  if (input.name && existing.name && input.name.trim() !== existing.name.trim()) {
    try {
      const moved = await renameFiledCategory(existing.name.trim(), input.name.trim());
      logger.info(`[Categories] "${existing.name}" renamed "${input.name}": ${moved} stored rows follow it.`);
    } catch (err: any) {
      // The rename itself stands. The trainer also resolves the old name
      // through the category's role (sugo_category/catalogue.py), so a row
      // missed here is still learned under the right category.
      logger.warn(`[Categories] Could not move stored rows to the new name: ${err?.message ?? err}`);
    }
  }

  // Fires for a status flip in particular. Deactivating a category in the owner
  // portal is meant to remove it from the customer's Bento grid, and until this
  // event existed the app had no way to learn that had happened — the tile sat
  // there until the customer pulled to refresh or killed the app.
  announceCatalogueChange("updated", id);
  triggerCategoryAutoLearning({ reason: "updated", categoryId: id });
  return category;
}

/**
 * Rewrites stored category text from `oldName` to `newName`: the bare name,
 * and the composite "Store N - <shop> | <name>" the console writes. Only the
 * text after the last " | " is the category, so a shop whose name merely
 * contains the category name is left alone. Returns how many rows changed.
 */
export async function renameFiledCategory(oldName: string, newName: string): Promise<number> {
  if (!oldName || !newName || oldName === newName) return 0;
  const suffix = ` | ${oldName}`;
  const composite = async (model: "pabiliDetail" | "pabiliItemRequest") => {
    const rows: Array<{ storeCategory: string | null }> = await (prisma as any)[model].findMany({
      where: { storeCategory: { endsWith: suffix } },
      select: { storeCategory: true },
      distinct: ["storeCategory"],
    });
    return rows
      .map((r) => r.storeCategory)
      .filter((value): value is string => Boolean(value && value.endsWith(suffix)))
      .map((value) => ({ from: value, to: `${value.slice(0, value.length - suffix.length)} | ${newName}` }));
  };
  const [details, requests] = await Promise.all([composite("pabiliDetail"), composite("pabiliItemRequest")]);

  const results = await prisma.$transaction([
    prisma.pabiliDetail.updateMany({ where: { storeCategory: oldName }, data: { storeCategory: newName } }),
    prisma.pabiliItemRequest.updateMany({ where: { storeCategory: oldName }, data: { storeCategory: newName } }),
    prisma.crawledMerchantItem.updateMany({ where: { categoryName: oldName }, data: { categoryName: newName } }),
    ...details.map(({ from, to }) =>
      prisma.pabiliDetail.updateMany({ where: { storeCategory: from }, data: { storeCategory: to } })
    ),
    ...requests.map(({ from, to }) =>
      prisma.pabiliItemRequest.updateMany({ where: { storeCategory: from }, data: { storeCategory: to } })
    ),
  ]);
  return results.reduce((sum, r) => sum + r.count, 0);
}

// --- Hero image (`store_cat_image`) ---------------------------------------

async function assertCategoryExists(categoryId: number) {
  const category = await merchantCategoryRepository.findById(categoryId);
  if (!category) {
    throw new ServiceError(404, "Merchant category not found");
  }
  return category;
}

// Returns the full base64 payload. Deliberately a separate call from
// listMerchantCategories so the Bento grid pays for the bytes once per
// category rather than on every list refresh.
export async function getCategoryImage(categoryId: number) {
  await assertCategoryExists(categoryId);

  const image = await merchantCategoryRepository.findImageByCategoryId(categoryId);
  if (!image) {
    throw new ServiceError(404, "This category has no image set.");
  }
  return image;
}

export async function setCategoryImage(categoryId: number, input: StoreCategoryImageUploadInput) {
  await assertCategoryExists(categoryId);

  const saved = await merchantCategoryRepository.upsertImage(categoryId, input);

  // The blob is echoed straight back to the uploader in the customer-photo
  // endpoints, which doubles the response for no gain. Return metadata only -
  // the owner portal already holds the preview it just uploaded.
  announceCatalogueChange("image-set", categoryId);

  return {
    categoryId,
    mimeType: saved.mimeType,
    fileSize: saved.fileSize,
    fileName: saved.fileName,
    updatedAt: saved.updatedAt,
  };
}

export async function removeCategoryImage(categoryId: number) {
  await assertCategoryExists(categoryId);

  const result = await merchantCategoryRepository.deleteImageByCategoryId(categoryId);
  if (result.count > 0) {
    announceCatalogueChange("image-removed", categoryId);
  }
  return { categoryId, removed: result.count > 0 };
}
