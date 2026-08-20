import { prisma } from "../lib/prisma.js";

export interface CreateModificationLogInput {
  role: string;
  userId?: number | null;
  customerId?: number | null;
  fieldModified: string;
  oldValue?: string | null;
  newValue?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  verifiedVia?: string;
}

export const accountAuditRepository = {
  create(data: CreateModificationLogInput) {
    return prisma.accountModificationLog.create({
      data: {
        role: data.role,
        userId: data.userId || null,
        customerId: data.customerId || null,
        fieldModified: data.fieldModified,
        oldValue: data.oldValue ?? null,
        newValue: data.newValue ?? null,
        ipAddress: data.ipAddress ?? null,
        userAgent: data.userAgent ?? null,
        verifiedVia: data.verifiedVia || "RECAPTCHA",
      },
    });
  },

  createMany(items: CreateModificationLogInput[]) {
    if (items.length === 0) return Promise.resolve({ count: 0 });
    return prisma.accountModificationLog.createMany({
      data: items.map((item) => ({
        role: item.role,
        userId: item.userId || null,
        customerId: item.customerId || null,
        fieldModified: item.fieldModified,
        oldValue: item.oldValue ?? null,
        newValue: item.newValue ?? null,
        ipAddress: item.ipAddress ?? null,
        userAgent: item.userAgent ?? null,
        verifiedVia: item.verifiedVia || "RECAPTCHA",
      })),
    });
  },

  findByCustomerId(customerId: number) {
    return prisma.accountModificationLog.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
    });
  },

  findByUserId(userId: number) {
    return prisma.accountModificationLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  },

  listAll(limit = 100) {
    return prisma.accountModificationLog.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, username: true, role: true } },
        customer: { select: { id: true, username: true, email: true } },
      },
    });
  },
};
