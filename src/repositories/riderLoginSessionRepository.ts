import { prisma } from "../lib/prisma.js";

export const riderLoginSessionRepository = {
  open(riderId: number) {
    return prisma.riderLoginSession.create({ data: { riderId } });
  },

  // The rider's own most recent still-open session, if any — used on logout
  // so we close the right row without the caller needing to track session ids.
  findOpenForRider(riderId: number) {
    return prisma.riderLoginSession.findFirst({
      where: { riderId, logoutAt: null },
      orderBy: { loginAt: "desc" },
    });
  },

  // All open sessions, for the periodic sweep to check against current presence.
  findAllOpen() {
    return prisma.riderLoginSession.findMany({ where: { logoutAt: null } });
  },

  // Conditional close (WHERE logoutAt IS NULL) so a real logout and the
  // abandoned-session sweep can't both close the same row and double-write it.
  close(id: number, logoutAt: Date, durationSeconds: number) {
    return prisma.riderLoginSession.updateMany({
      where: { id, logoutAt: null },
      data: { logoutAt, durationSeconds },
    });
  },

  /**
   * Sessions that overlap a range, for the Rider Performance report's
   * errands-per-active-hour figure.
   *
   * Includes still-open sessions (`logoutAt: null`) that began before the window
   * closed. A rider mid-shift when the report is run has real hours on the clock
   * and excluding them would divide their completed errands by a smaller number,
   * flattering exactly the riders whose day is not yet finished. The caller
   * clamps an open session's end to the window rather than counting it whole.
   */
  findOverlappingBetween(start: Date, end: Date) {
    return prisma.riderLoginSession.findMany({
      where: {
        OR: [
          { logoutAt: { gte: start, lt: end } },
          { logoutAt: null, loginAt: { lt: end } },
        ],
      },
      select: { riderId: true, loginAt: true, logoutAt: true, durationSeconds: true },
    });
  },
};
