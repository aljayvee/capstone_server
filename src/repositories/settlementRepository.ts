import { prisma } from "../lib/prisma.js";
import {
  ADJUSTMENT_SELECT,
  settlementAdjustmentRepository,
} from "./settlementAdjustmentRepository.js";

export interface CreateSettlementData {
  errandId: string;
  riderId: number;
  expectedAmount: number;
  collectedAmount: number;
  variance: number;
  status: string;
  /** Why the cash came back short. Only set on a SHORT settlement. */
  shortReason?: string | null;
  /** The photo (cash-in-hand or GCash/Maya receipt) backing this settlement. */
  proofImageId?: number | null;
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
  findBetweenWithRider(start: Date, end: Date, riderId?: number) {
    return prisma.settlementRecord.findMany({
      // riderId: the Settlement report's one-rider view; other callers omit it.
      where: { settledAt: { gte: start, lt: end }, ...(riderId ? { riderId } : {}) },
      select: {
        id: true,
        errandId: true,
        errand: { select: { referenceNo: true } },
        riderId: true,
        expectedAmount: true,
        collectedAmount: true,
        variance: true,
        status: true,
        shortReason: true,
        settledAt: true,
        rider: { select: { firstName: true, lastName: true } },
        // What has happened to a short since, as of now (not as of the window).
        adjustments: { select: ADJUSTMENT_SELECT, orderBy: { recordedAt: "asc" } },
      },
      orderBy: { settledAt: "desc" },
    });
  },

  findRepaymentsBetweenWithSettlement(start: Date, end: Date, riderId?: number) {
    return settlementAdjustmentRepository.findRepaymentsBetweenWithSettlement(start, end, riderId);
  },
};
