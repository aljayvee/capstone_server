import { prisma } from "../lib/prisma.js";

export interface CommissionCreateInput {
  errandId: string;
  riderId: number;
  deliveryFee: number;
  tip: number;
  commissionRate: number;
  riderShare: number;
  businessShare: number;
  itemCostExcluded: number;
}

export const commissionRepository = {
  findByErrandId(errandId: string) {
    return prisma.riderCommission.findUnique({ where: { errandId } });
  },

  // upsert rather than create: an errand can pass through DELIVERED and then
  // COMPLETED, and both are points at which a payout could plausibly be recorded.
  // Recomputing on the later transition is correct — the fee can still change
  // between them if a receipt total lands — while a bare create would throw on
  // the unique errandId.
  record(data: CommissionCreateInput) {
    const { errandId, ...rest } = data;
    return prisma.riderCommission.upsert({
      where: { errandId },
      create: { errandId, ...rest },
      update: { ...rest, computedAt: new Date() },
    });
  },

  // Per-rider payout history, newest first. Backs the rider's own earnings view:
  // "why was I paid this" is answerable from the stored inputs alone.
  listForRider(riderId: number, limit = 50) {
    return prisma.riderCommission.findMany({
      where: { riderId },
      orderBy: { computedAt: "desc" },
      take: limit,
      include: {
        errand: { select: { id: true, category: true, deliveredAt: true, completedAt: true } },
      },
    });
  },

  totalsForRider(riderId: number, start: Date, end: Date) {
    return prisma.riderCommission.aggregate({
      where: { riderId, computedAt: { gte: start, lt: end } },
      _sum: { riderShare: true, businessShare: true, deliveryFee: true, tip: true },
      _count: { _all: true },
    });
  },
};
