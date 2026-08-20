import { prisma } from "../lib/prisma.js";

export const tokenBlocklistRepository = {
  findByToken(token: string) {
    return prisma.tokenBlocklist.findUnique({ where: { token } });
  },

  revoke(token: string, expiresAt: Date) {
    return prisma.tokenBlocklist.upsert({
      where: { token },
      update: {},
      create: { token, expiresAt },
    });
  },

  deleteExpired() {
    return prisma.tokenBlocklist.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  },
};
