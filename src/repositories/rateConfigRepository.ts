import { prisma } from "../lib/prisma.js";

export interface RateConfigInput {
  baseFee: number;
  perKmRate: number;
  multiStoreFeePerStore: number;
  maxAdditionalStores: number;
  groceryFeeThreshold: number;
  groceryFeePercent: number;
  groceryFeeFlat: number;
  nonCodThreshold: number;
  nonCodFeeHigh: number;
  nonCodFeeLow: number;
}

export const rateConfigRepository = {
  findFirst() {
    return prisma.rateConfig.findFirst();
  },

  upsert(data: RateConfigInput) {
    return prisma.rateConfig.upsert({
      where: { id: 1 },
      update: data,
      create: { id: 1, ...data },
    });
  },
};
