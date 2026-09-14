import { prisma } from "../lib/prisma.js";

export interface CreateSettlementData {
  errandId: string;
  riderId: number;
  expectedAmount: number;
  collectedAmount: number;
  variance: number;
  status: string;
  /** Why the cash came back short. Only set on a SHORT settlement. */
  shortReason?: string | null;
}

export const settlementRepository = {
  findByErrandId(errandId: string) {
    return prisma.settlementRecord.findUnique({ where: { errandId } });
  },

  create(data: CreateSettlementData) {
    return prisma.settlementRecord.create({ data });
  },

  /**
   * Every settlement reconciled in a range, with the rider who handed the cash
   * over. Backs the Settlement report's per-rider lines.
   *
   * Windowed on `settledAt`, which is NOT the window the rest of that report
   * uses — the revenue half runs on `Errand.createdAt`. An errand created on the
   * last of the month and settled on the first of the next belongs to one
   * month's revenue and the next month's cash, and both are correct. The report
   * labels the two sections with their basis rather than merging them, because
   * silently mixed windows read as missing money.
   */
  findBetweenWithRider(start: Date, end: Date) {
    return prisma.settlementRecord.findMany({
      where: { settledAt: { gte: start, lt: end } },
      select: {
        errandId: true,
        riderId: true,
        expectedAmount: true,
        collectedAmount: true,
        variance: true,
        status: true,
        shortReason: true,
        settledAt: true,
        rider: { select: { firstName: true, lastName: true } },
      },
      orderBy: { settledAt: "desc" },
    });
  },
};
