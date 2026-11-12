import { prisma } from "../lib/prisma.js";

export type RiderDeclineKindValue = "DECLINED" | "EXPIRED";

export interface CreateRiderOfferDeclineData {
  riderId: number;
  errandId: string;
  kind: RiderDeclineKindValue;
  reason?: string | null;
  offeredAt?: Date | null;
}

// Offers a rider turned down or let run out. Append-only: errandService writes
// one row per decline and nothing updates or deletes them, because the row is
// the only record left once the errand's riderId has been cleared.
export const riderOfferDeclineRepository = {
  create(data: CreateRiderOfferDeclineData) {
    return prisma.riderOfferDecline.create({ data });
  },

  // Declines per rider and kind in a range, for the Rider Performance report.
  countByRiderBetween(start: Date, end: Date) {
    return prisma.riderOfferDecline.groupBy({
      by: ["riderId", "kind"],
      where: { declinedAt: { gte: start, lt: end } },
      _count: { _all: true },
    });
  },

  // One rider's declines in a range, newest first, so the count in their report
  // can be traced to the offers under it.
  findForRiderBetween(riderId: number, start: Date, end: Date) {
    return prisma.riderOfferDecline.findMany({
      where: { riderId, declinedAt: { gte: start, lt: end } },
      select: {
        id: true,
        errandId: true,
        kind: true,
        reason: true,
        offeredAt: true,
        declinedAt: true,
        errand: { select: { referenceNo: true } },
      },
      orderBy: { declinedAt: "desc" },
    });
  },
};
