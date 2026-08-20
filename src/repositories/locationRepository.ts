import { prisma } from "../lib/prisma.js";

export interface LocationInput {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

export const locationRepository = {
  findByCustomerId(customerId: number) {
    return prisma.savedDeliveryLocation.findMany({
      where: { customerId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  },

  countByCustomerId(customerId: number) {
    return prisma.savedDeliveryLocation.count({ where: { customerId } });
  },

  findById(id: number) {
    return prisma.savedDeliveryLocation.findUnique({ where: { id } });
  },

  create(customerId: number, data: LocationInput, isDefault: boolean) {
    return prisma.savedDeliveryLocation.create({ data: { customerId, ...data, isDefault } });
  },

  // Handles the "set as default" transaction: clear the customer's other defaults,
  // then apply the update, atomically — mirrors the original two-step $transaction.
  async updateWithOptionalDefault(id: number, customerId: number, data: LocationInput, setAsDefault: boolean) {
    if (setAsDefault) {
      await prisma.$transaction([
        prisma.savedDeliveryLocation.updateMany({
          where: { customerId, isDefault: true },
          data: { isDefault: false },
        }),
        prisma.savedDeliveryLocation.update({ where: { id }, data: { ...data, isDefault: true } }),
      ]);
    } else {
      await prisma.savedDeliveryLocation.update({ where: { id }, data });
    }
    return prisma.savedDeliveryLocation.findUnique({ where: { id } });
  },

  delete(id: number) {
    return prisma.savedDeliveryLocation.delete({ where: { id } });
  },

  findOldestByCustomerId(customerId: number) {
    return prisma.savedDeliveryLocation.findFirst({ where: { customerId }, orderBy: { createdAt: "asc" } });
  },

  setDefault(id: number) {
    return prisma.savedDeliveryLocation.update({ where: { id }, data: { isDefault: true } });
  },
};
