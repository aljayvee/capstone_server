import { prisma } from "../lib/prisma.js";

export const paymentModeRepository = {
  findMany() {
    return prisma.paymentMode.findMany({ orderBy: { id: "asc" } });
  },

  findById(id: number) {
    return prisma.paymentMode.findUnique({ where: { id } });
  },

  findByName(name: string) {
    return prisma.paymentMode.findUnique({ where: { name } });
  },
};
