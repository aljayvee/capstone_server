import { prisma } from "../lib/prisma.js";

export interface PabiliDetailInput {
  itemName: string;
  storeCategory?: string;
  quantity: number;
}

export const pabiliDetailRepository = {
  findByErrandId(errandId: string) {
    return prisma.pabiliDetail.findMany({ where: { errandId }, orderBy: { id: "asc" } });
  },

  // Atomic replace-all: mirrors pinpointRepository.replaceForErrand — delete
  // existing rows then insert the new set in one transaction, so a dispatcher
  // re-saving items never leaves stale rows mixed in.
  replaceForErrand(errandId: string, items: PabiliDetailInput[]) {
    return prisma.$transaction([
      prisma.pabiliDetail.deleteMany({ where: { errandId } }),
      prisma.pabiliDetail.createMany({
        data: items.map((item) => ({
          errandId,
          itemName: item.itemName,
          storeCategory: item.storeCategory || null,
          quantity: item.quantity,
        })),
      }),
    ]);
  },
};
