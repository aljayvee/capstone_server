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
};
