import { prisma } from "../lib/prisma.js";

export const paymentSelectionRepository = {
  findByErrandId(errandId: string) {
    return prisma.paymentSelection.findUnique({
      where: { errandId },
      include: { paymentMode: true },
    });
  },

  create(errandId: string, paymentModeId: number) {
    return prisma.paymentSelection.create({
      data: { errandId, paymentModeId },
      include: { paymentMode: true },
    });
  },
};
