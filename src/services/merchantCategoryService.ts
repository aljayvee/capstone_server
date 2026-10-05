import { merchantCategoryRepository } from "../repositories/merchantCategoryRepository.js";
import { ServiceError } from "./ServiceError.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { findBlockedCategoryTerm } from "../lib/blockedCategoryNames.js";
import { triggerCategoryAutoLearning } from "./categoryRetrainingService.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type {
  CreateMerchantCategoryInput,
  UpdateMerchantCategoryInput,
  StoreCategoryImageUploadInput,
} from "../validators/merchantCategoryValidators.js";

export function listMerchantCategories(includeInactive = false) {
  return merchantCategoryRepository.findMany({ includeInactive });
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
