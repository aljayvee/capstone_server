import type { NotificationPriority, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import {
  isRiderNotificationType,
  presentCustomerNotification,
  presentRiderNotification,
} from "../services/notificationCatalog.js";

export interface CreateNotificationData {
  userId?: number;
  customerId?: number;
  type: string;
  title: string;
  body: string;
  priority?: NotificationPriority;
  refKey?: string | null;
}

export type NotificationSort = "newest" | "oldest" | "priority";

/** A staff bell's search, sort and page. Every field is already validated. */
export interface NotificationListQuery {
  q?: string;
  sort: NotificationSort;
  priorities?: NotificationPriority[];
  unreadOnly?: boolean;
  types?: string[];
  /** Types this caller must never be shown (an owner: see OWNER_HIDDEN_TYPES). */
  excludeTypes?: string[];
  limit: number;
  offset: number;
}

/** The where/orderBy for one page of a staff member's notifications. Exported for tests. */
export function buildUserListQuery(userId: number, query: NotificationListQuery) {
  const where: Prisma.NotificationWhereInput = { userId };
  if (query.unreadOnly) where.isRead = false;
  if (query.priorities?.length) where.priority = { in: query.priorities };
  const excluded = query.excludeTypes ?? [];
  if (query.types?.length) where.type = { in: query.types.filter((t) => !excluded.includes(t)) };
  else if (excluded.length) where.type = { notIn: excluded };
  if (query.q) where.OR = [{ title: { contains: query.q } }, { body: { contains: query.q } }];

  // MySQL sorts an ENUM by declaration index (LOW..CRITICAL), so desc is Critical first.
  const orderBy: Prisma.NotificationOrderByWithRelationInput[] =
    query.sort === "priority"
      ? [{ priority: "desc" }, { createdAt: "desc" }, { id: "desc" }]
      : query.sort === "oldest"
        ? [{ createdAt: "asc" }, { id: "asc" }]
        : [{ createdAt: "desc" }, { id: "desc" }];

  return { where, orderBy, take: query.limit, skip: query.offset };
}

function emitNew(record: { userId: number | null; customerId: number | null; type: string; refKey?: string | null; isRead?: boolean }) {
  try {
    if (record.userId) {
      // A rider's row goes out presented (topic, actionNeeded, errandId); staff rows as stored.
      eventPublisher.emitToUser(
        record.userId,
        "notification:new",
        isRiderNotificationType(record.type) ? presentRiderNotification(record) : record
      );
    }
    if (record.customerId) {
      // The customer app reads category, needsYou and errandId; the list sends the same.
      eventPublisher.emitToCustomer(record.customerId, "notification:new", presentCustomerNotification(record));
    }
  } catch {
    // Socket notification delivery must never fail database persistence
  }
}

export const notificationRepository = {
  findForUser(userId: number, excludeTypes: string[] = []) {
    return prisma.notification.findMany({
      where: excludeTypes.length ? { userId, type: { notIn: excludeTypes } } : { userId },
      orderBy: { createdAt: "desc" },
    });
  },

  /** One page of a staff member's notifications, and how many match in all. */
  async findPageForUser(userId: number, query: NotificationListQuery) {
    const { where, orderBy, take, skip } = buildUserListQuery(userId, query);
    const [items, total] = await Promise.all([
      prisma.notification.findMany({ where, orderBy, take, skip }),
      prisma.notification.count({ where }),
    ]);
    return { items, total };
  },

  findForCustomer(customerId: number) {
    return prisma.notification.findMany({ where: { customerId }, orderBy: { createdAt: "desc" } });
  },

  findById(id: number) {
    return prisma.notification.findUnique({ where: { id } });
  },

  async create(data: CreateNotificationData) {
    const record = await prisma.notification.create({ data });
    emitNew(record);
    return record;
  },

  /** The unread row a collapsing type folds new events into, if there is one. */
  findUnreadByRef(userId: number, type: string, refKey: string) {
    return prisma.notification.findFirst({
      where: { userId, type, refKey, isRead: false },
      orderBy: { createdAt: "desc" },
    });
  },

  /** findUnreadByRef for a customer's bell (customer chat collapses the same way). */
  findUnreadByRefForCustomer(customerId: number, type: string, refKey: string) {
    return prisma.notification.findFirst({
      where: { customerId, type, refKey, isRead: false },
      orderBy: { createdAt: "desc" },
    });
  },

  /** Folds a new event into an unread row: new text, new time, same id. Emits like create. */
  async bump(id: number, data: Pick<CreateNotificationData, "title" | "body" | "priority">) {
    const record = await prisma.notification.update({
      where: { id },
      data: { ...data, createdAt: new Date() },
    });
    emitNew(record);
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
