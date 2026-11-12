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

  // Insert-only twin of revoke(): resolves false when the token was already
  // listed. The unique index makes it the one-winner check for single-use
  // tokens, where a read-then-write would let two concurrent requests both pass.
  async claim(token: string, expiresAt: Date): Promise<boolean> {
    try {
      await prisma.tokenBlocklist.create({ data: { token, expiresAt } });
      return true;
    } catch (error: any) {
      if (error?.code === "P2002") return false;
      throw error;
    }
  },

  deleteExpired() {
    return prisma.tokenBlocklist.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  },
};
