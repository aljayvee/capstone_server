import { prisma } from "../lib/prisma.js";
import { eventPublisher } from "../lib/eventPublisher.js";

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

  async create(data: CreateNotificationData) {
    const record = await prisma.notification.create({ data });
    try {
      if (record.userId) {
        eventPublisher.emitToUser(record.userId, "notification:new", record);
      }
      if (record.customerId) {
        eventPublisher.emitToCustomer(record.customerId, "notification:new", record);
      }
    } catch {
      // Socket notification delivery must never fail database persistence
    }
    return record;
  },

  markRead(id: number) {
    return prisma.notification.update({ where: { id }, data: { isRead: true } });
  },

  markAllReadForCustomer(customerId: number) {
    return prisma.notification.updateMany({
      where: { customerId, isRead: false },
      data: { isRead: true },
    });
  },

  markAllReadForUser(userId: number) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  },
};
