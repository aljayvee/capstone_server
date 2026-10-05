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
  // Preserves fulfillmentStatus ("PURCHASED" | "OUT_OF_STOCK") for items that were
  // NOT modified by the dispatcher, while resetting any modified item back to
  // "PENDING" so its checkbox becomes available again in Sugo Rider.
  async replaceForErrand(errandId: string, items: PabiliDetailInput[]) {
    const existingRows = await prisma.pabiliDetail.findMany({
      where: { errandId },
      orderBy: { id: "asc" },
    });

    const normalize = (v?: string | null) => String(v ?? "").trim().toLowerCase();

    const rowsToCreate = items.map((item, index) => {
      const prev = existingRows[index];
      const isUnmodified =
        prev !== undefined &&
        normalize(prev.itemName) === normalize(item.itemName) &&
        Number(prev.quantity) === Number(item.quantity) &&
        normalize(prev.storeCategory) === normalize(item.storeCategory);

      return {
        errandId,
        itemName: item.itemName,
        storeCategory: item.storeCategory || null,
        quantity: item.quantity,
        fulfillmentStatus: isUnmodified ? (prev.fulfillmentStatus || "PENDING") : "PENDING",
      };
    });

    return prisma.$transaction([
      prisma.pabiliDetail.deleteMany({ where: { errandId } }),
      prisma.pabiliDetail.createMany({
        data: rowsToCreate,
      }),
    ]);
  },
};
