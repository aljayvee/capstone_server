import { prisma } from "../lib/prisma.js";

export interface CreateCodeData {
  customerId?: number | null;
  email?: string | null;
  phone?: string | null;
  codeHash: string;
  expiresAt: Date;
}

export const emailVerificationRepository = {
  create(data: CreateCodeData) {
    return prisma.emailVerificationCode.create({ data });
  },

  findLatestActiveForCustomer(customerId: number) {
    return prisma.emailVerificationCode.findFirst({
      where: { customerId, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
  },

  findLatestActiveForEmail(email: string) {
    return prisma.emailVerificationCode.findFirst({
      where: { email: email.toLowerCase().trim(), consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
  },

  findLatestActiveForPhone(phone: string) {
    return prisma.emailVerificationCode.findFirst({
      where: { phone: phone.trim(), consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
  },

  incrementAttempts(id: number) {
    return prisma.emailVerificationCode.update({ where: { id }, data: { attempts: { increment: 1 } } });
  },

  markConsumed(id: number) {
    return prisma.emailVerificationCode.update({ where: { id }, data: { consumedAt: new Date() } });
  },
};
