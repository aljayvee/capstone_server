import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface SettlementAdjustmentCreateInput {
  settlementId: number;
  kind: string;
  amount: number;
  reference: string | null;
  note: string | null;
  reviewId: number | null;
  recordedById: number;
}

/** What a report or the Help Desk shows for one adjustment. */
export const ADJUSTMENT_SELECT = {
  id: true,
  kind: true,
  amount: true,
  reference: true,
  note: true,
  recordedAt: true,
  recordedById: true,
  voidedAt: true,
  recordedBy: { select: { firstName: true, lastName: true, username: true } },
} satisfies Prisma.SettlementAdjustmentSelect;

/** See SettlementAdjustment in schema.prisma: append-only, voided rather than deleted. */
export const settlementAdjustmentRepository = {
  create(data: SettlementAdjustmentCreateInput, db: Db = prisma) {
    return db.settlementAdjustment.create({ data });
  },

  findById(id: number) {
    return prisma.settlementAdjustment.findUnique({
      where: { id },
      include: { settlement: { select: { errandId: true } } },
    });
  },

  /** Marks one undone, only if it still stands; returns the number of rows changed. */
  async voidIfStanding(id: number, userId: number): Promise<number> {
    const { count } = await prisma.settlementAdjustment.updateMany({
      where: { id, voidedAt: null },
      data: { voidedAt: new Date(), voidedById: userId },
    });
    return count;
  },

  /**
   * Every short handover with its adjustments, newest first: the source of the
   * Help Desk's "Money still owed" list. Shorts are rare enough to read whole;
   * the caller keeps the ones with something still owed.
   */
  findShortSettlementsWithAdjustments() {
    return prisma.settlementRecord.findMany({
      where: { status: "SHORT" },
      select: {
        id: true,
        errandId: true,
        errand: { select: { referenceNo: true } },
        riderId: true,
        rider: { select: { firstName: true, lastName: true } },
        expectedAmount: true,
        collectedAmount: true,
        variance: true,
        shortReason: true,
        settledAt: true,
        adjustments: { select: ADJUSTMENT_SELECT, orderBy: { recordedAt: "asc" } },
      },
      orderBy: { settledAt: "desc" },
    });
  },

  /**
   * Every standing Help Desk repayment (rider paid back or customer paid by
   * GCash) recorded in `[start, end)`, with its parent settlement and rider.
   * Backs repayment transaction rows in the Settlement report, including when
   * the original handover happened before `start`.
   */
  findRepaymentsBetweenWithSettlement(start: Date, end: Date, riderId?: number) {
    return prisma.settlementAdjustment.findMany({
      where: {
        recordedAt: { gte: start, lt: end },
        voidedAt: null,
        kind: { in: ["RIDER_PAID_BACK", "CUSTOMER_PAID_GCASH"] },
        ...(riderId ? { settlement: { riderId } } : {}),
      },
      select: {
        ...ADJUSTMENT_SELECT,
        settlementId: true,
        settlement: {
          select: {
            id: true,
            errandId: true,
            errand: { select: { referenceNo: true } },
            riderId: true,
            rider: { select: { firstName: true, lastName: true } },
            expectedAmount: true,
            collectedAmount: true,
            variance: true,
            shortReason: true,
            settledAt: true,
            adjustments: { select: ADJUSTMENT_SELECT, orderBy: { recordedAt: "asc" } },
          },
        },
      },
      orderBy: { recordedAt: "desc" },
    });
  },
};
