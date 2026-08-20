import { prisma } from "../lib/prisma.js";

export interface CreateSettlementData {
  errandId: string;
  riderId: number;
  expectedAmount: number;
  collectedAmount: number;
  variance: number;
  status: string;
}

export const settlementRepository = {
  findByErrandId(errandId: string) {
    return prisma.settlementRecord.findUnique({ where: { errandId } });
  },

  create(data: CreateSettlementData) {
    return prisma.settlementRecord.create({ data });
  },
};
