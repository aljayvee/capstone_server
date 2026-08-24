import { prisma } from "../lib/prisma.js";
import type { StoreCategoryImageUploadInput } from "../validators/merchantCategoryValidators.js";

export interface CreateMerchantCategoryData {
  name: string;
  description?: string;
}

export interface UpdateMerchantCategoryData {
  name?: string;
  description?: string;
  status?: string;
  // Both of these already reached Prisma — the validated input is passed
  // straight through, and TypeScript's excess-property check does not apply to
  // a variable. Naming them here makes the type describe what this actually
  // writes rather than relying on that.
  handlingFeeMode?: "THRESHOLD" | "FLAT" | "PERCENT" | "NONE";
  geofenceRadiusMeters?: number;
}

export const merchantCategoryRepository = {
  // Defaults to active categories only. Deactivating a category is how a store
  // type is retired from the Pabili picker (see the Bills & Payment Centers
  // removal), so an unfiltered list would leave retired types selectable by
  // customers. The owner portal opts back in to manage them.
  findMany(options: { includeInactive?: boolean } = {}) {
    return prisma.merchantCategory.findMany({
      where: options.includeInactive ? undefined : { status: "Active" },
      include: {
        _count: {
          select: { places: true },
        },
        // Metadata only - never `imageData`. This list is fetched on every
        // CustomerApp launch to build the Bento grid; inlining a base64 blob
        // per category would turn a ~2KB response into megabytes. `updatedAt`
        // is the cache key the client uses to decide whether to re-fetch the
        // bytes from GET /merchant-categories/:id/image.
        image: {
          select: { mimeType: true, fileSize: true, updatedAt: true },
        },
      },
      orderBy: { name: "asc" },
    });
  },

  findById(id: number) {
    return prisma.merchantCategory.findUnique({ where: { id } });
  },

  create(data: CreateMerchantCategoryData) {
    return prisma.merchantCategory.create({ data });
  },

  update(id: number, data: UpdateMerchantCategoryData) {
    return prisma.merchantCategory.update({ where: { id }, data });
  },

  // --- Hero image (`store_cat_image`) -------------------------------------
  // Split from the category reads above so the blob is only ever loaded when
  // something actually asks for the pixels.

  findImageByCategoryId(categoryId: number) {
    return prisma.storeCategoryImage.findUnique({ where: { categoryId } });
  },

  upsertImage(categoryId: number, data: StoreCategoryImageUploadInput) {
    const fields = {
      imageData: data.imageData,
      mimeType: data.mimeType,
      fileSize: data.fileSize,
      fileName: data.fileName || null,
    };
    return prisma.storeCategoryImage.upsert({
      where: { categoryId },
      create: { categoryId, ...fields },
      update: fields,
    });
  },

  // deleteMany, not delete: removing an image that is already absent is the
  // same outcome the caller wanted, so it must not throw P2025.
  deleteImageByCategoryId(categoryId: number) {
    return prisma.storeCategoryImage.deleteMany({ where: { categoryId } });
  },
};
