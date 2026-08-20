import { prisma } from "../lib/prisma.js";

const WITH_ERRAND_DETAILS = {
  errand: {
    include: {
      pabiliDetails: true,
      pinpoints: { orderBy: { sequence: "asc" as const } },
      rider: { select: { firstName: true, lastName: true } },
    },
  },
} as const;

// Transaction Summary report needs rider name, customer name, and full errand
// context in one shot — a superset of WITH_ERRAND_DETAILS above.
const WITH_REPORT_DETAILS = {
  errand: {
    select: {
      id: true,
      category: true,
      pickupAddress: true,
      deliveryAddress: true,
      deliveryFee: true,
      estimatedCost: true,
      rider: { select: { firstName: true, lastName: true } },
    },
  },
  customer: { select: { information: { select: { firstName: true, lastName: true } } } },
} as const;

export const customerTransactionRepository = {
  create(customerId: number, errandId: string, amount: number, paymentMethod: string) {
    return prisma.customerTransaction.create({
      data: { customerId, errandId, amount, paymentMethod },
    });
  },

  findByCustomerId(customerId: number) {
    return prisma.customerTransaction.findMany({
      where: { customerId },
      include: WITH_ERRAND_DETAILS,
      orderBy: { createdAt: "desc" },
    });
  },

  updateAmountByErrandId(errandId: string, amount: number) {
    return prisma.customerTransaction.updateMany({
      where: { errandId },
      data: { amount },
    });
  },

  findBetween(start: Date, end: Date) {
    return prisma.customerTransaction.findMany({
      where: { createdAt: { gte: start, lt: end } },
      include: WITH_REPORT_DETAILS,
      orderBy: { createdAt: "desc" },
    });
  },
};
