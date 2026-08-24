import { prisma } from "../lib/prisma.js";

export interface CreateDeclineReasonData {
  errandId: string;
  dispatcherId: number;
  reason: string;
  isCustom: boolean;
}

export const errandDeclineRepository = {
  create(data: CreateDeclineReasonData) {
    return prisma.errandDeclineReason.create({ data });
  },

  /** Most recent first: a re-declined errand should surface the current reason. */
  findByErrandId(errandId: string) {
    return prisma.errandDeclineReason.findMany({
      where: { errandId },
      include: { dispatcher: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: "desc" },
    });
  },

  findLatestByErrandId(errandId: string) {
    return prisma.errandDeclineReason.findFirst({
      where: { errandId },
      include: { dispatcher: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: "desc" },
    });
  },
};
