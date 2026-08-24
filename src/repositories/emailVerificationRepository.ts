import { prisma } from "../lib/prisma.js";

export interface CreateCodeData {
  customerId?: number | null;
  userId?: number | null;
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

  findLatestActiveForUser(userId: number) {
    return prisma.emailVerificationCode.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
  },

  // Retires every outstanding code for a staff account, so exactly one is ever
  // live. Without it, a second sign-in attempt leaves the older code silently
  // dead and the person cannot tell which of two emails to trust.
  consumeAllForUser(userId: number) {
    return prisma.emailVerificationCode.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  },

  // Same one-live-code rule the staff flow uses: a password reset that issues a
  // second code must kill the first, or the customer cannot tell which of two
  // emails is the real one.
  consumeAllForCustomer(customerId: number) {
    return prisma.emailVerificationCode.updateMany({
      where: { customerId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  },

  findLatestActiveForEmail(email: string) {
    return prisma.emailVerificationCode.findFirst({
      where: { email: email.toLowerCase().trim(), consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
  },

  // Registration codes are keyed by email, not customerId — the account does not
  // exist yet. Same one-live-code rule as consumeAllForCustomer.
  consumeAllForEmail(email: string) {
    return prisma.emailVerificationCode.updateMany({
      where: { email: email.toLowerCase().trim(), consumedAt: null },
      data: { consumedAt: new Date() },
    });
  },

  // How many codes this address has been sent since `since` — the streak that
  // drives the doubling resend cooldown.
  countRecentForEmail(email: string, since: Date) {
    return prisma.emailVerificationCode.count({
      where: { email: email.toLowerCase().trim(), createdAt: { gte: since } },
    });
  },

  // The most recent code for an address regardless of whether it was consumed.
  // The cooldown counts codes SENT, not codes still live — retiring a code does
  // not un-send the email it was carried in.
  findLatestForEmail(email: string) {
    return prisma.emailVerificationCode.findFirst({
      where: { email: email.toLowerCase().trim() },
      orderBy: { createdAt: "desc" },
    });
  },

  countRecentForCustomer(customerId: number, since: Date) {
    return prisma.emailVerificationCode.count({
      where: { customerId, createdAt: { gte: since } },
    });
  },

  findLatestForCustomer(customerId: number) {
    return prisma.emailVerificationCode.findFirst({
      where: { customerId },
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
