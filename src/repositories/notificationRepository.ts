import { prisma } from "../lib/prisma.js";

export interface CreateNotificationData {
  userId?: number;
  customerId?: number;
  type: string;
  title: string;
  body: string;
}

export const notificationRepository = {
  findForUser(userId: number) {
    return prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  },

  findForCustomer(customerId: number) {
    return prisma.notification.findMany({ where: { customerId }, orderBy: { createdAt: "desc" } });
  },

  findById(id: number) {
    return prisma.notification.findUnique({ where: { id } });
  },

  create(data: CreateNotificationData) {
    return prisma.notification.create({ data });
  },

  markRead(id: number) {
    return prisma.notification.update({ where: { id }, data: { isRead: true } });
  },
};
