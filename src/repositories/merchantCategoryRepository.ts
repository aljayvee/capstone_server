import { prisma } from "../lib/prisma.js";

export interface CreateMerchantCategoryData {
  name: string;
  description?: string;
}

export interface UpdateMerchantCategoryData {
  name?: string;
  description?: string;
  status?: string;
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
};
