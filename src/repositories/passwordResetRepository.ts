import { prisma } from "../lib/prisma.js";

export interface CreateAttemptInput {
  identifier: string;
  customerId?: number | null;
  outcome: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export const passwordResetRepository = {
  create(data: CreateAttemptInput) {
    return prisma.passwordResetAttempt.create({
      data: {
        identifier: data.identifier,
        customerId: data.customerId ?? null,
        outcome: data.outcome,
        ipAddress: data.ipAddress ?? null,
        userAgent: data.userAgent ?? null,
      },
    });
  },

  // How many times this IP has probed an identifier that resolved to nothing,
  // or been caught by the honeypot, inside the window. Deliberately counts only
  // the fruitless outcomes: a customer who genuinely forgot their password and
  // completed a reset should never edge closer to a block.
  countRecentMisses(ipAddress: string, since: Date) {
    return prisma.passwordResetAttempt.count({
      where: {
        ipAddress,
        createdAt: { gte: since },
        outcome: { in: ["UNKNOWN_ACCOUNT", "HONEYPOT"] },
      },
    });
  },

  // Distinct identifiers this IP has asked about in the window. One person
  // resetting their own password touches one identifier however many times they
  // retry; a script walking a username list touches many.
  async countDistinctIdentifiers(ipAddress: string, since: Date) {
    const rows = await prisma.passwordResetAttempt.findMany({
      where: { ipAddress, createdAt: { gte: since } },
      distinct: ["identifier"],
      select: { identifier: true },
    });
    return rows.length;
  },

  // The resend streak for one identifier.
  //
  // Counts AUDIT rows, not codes, and counts them for hits and misses alike.
  // That is deliberate: the backoff a caller is told about must be identical
  // whether or not the account exists, or the wait time itself becomes the
  // account oracle that the generic response exists to close. Exactly one row
  // is written per request in all three of these outcomes, so the count is the
  // same shape either way.
  countRecentRequestsForIdentifier(identifier: string, since: Date) {
    return prisma.passwordResetAttempt.count({
      where: {
        identifier: identifier.toLowerCase(),
        createdAt: { gte: since },
        outcome: { in: ["REQUESTED", "COOLDOWN", "UNKNOWN_ACCOUNT"] },
      },
    });
  },

  findLatestRequestForIdentifier(identifier: string) {
    return prisma.passwordResetAttempt.findFirst({
      where: {
        identifier: identifier.toLowerCase(),
        outcome: { in: ["REQUESTED", "COOLDOWN", "UNKNOWN_ACCOUNT"] },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  // Newest first, for review. Not mounted on a route yet — see the note in
  // passwordResetService.
  listRecent(limit = 100) {
    return prisma.passwordResetAttempt.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },

  listRecentForIp(ipAddress: string, limit = 100) {
    return prisma.passwordResetAttempt.findMany({
      where: { ipAddress },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },
};
