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
};
