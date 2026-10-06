import { prisma } from "../lib/prisma.js";
import { ITEM_SIZE_STORAGE } from "../config/env.js";
import { buildReplacementRows } from "../services/patterns/pabiliItemRows.js";

export interface PabiliDetailInput {
  itemName: string;
  storeCategory?: string;
  quantity: number;
  /** Omitted by clients built before the size column: the stored size is kept. */
  size?: string | null;
  /** Same as size: omitted means keep what is stored. */
  notes?: string | null;
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
  // A row that omits size keeps the size it had (buildReplacementRows), so an
  // older dispatcher build saving the list cannot erase every size on it.
  async replaceForErrand(errandId: string, items: PabiliDetailInput[]) {
    const existingRows = await prisma.pabiliDetail.findMany({
      where: { errandId },
      orderBy: { id: "asc" },
    });

    const rowsToCreate = buildReplacementRows(existingRows, items, ITEM_SIZE_STORAGE).map((row) => ({
      errandId,
      ...row,
    }));

    return prisma.$transaction([
      prisma.pabiliDetail.deleteMany({ where: { errandId } }),
      prisma.pabiliDetail.createMany({
        data: rowsToCreate,
      }),
    ]);
  },
};
