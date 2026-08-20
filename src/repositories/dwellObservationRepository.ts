import { prisma } from "../lib/prisma.js";

export interface DwellObservationCreateData {
  errandId: string;
  pinpointId: number;
  categoryId?: number | null;
  placeId?: string | null;
  dwellSeconds: number;
  arrivedAt: Date;
  departedAt: Date;
}

export const dwellObservationRepository = {
  create(data: DwellObservationCreateData) {
    return prisma.dwellObservation.create({ data });
  },

  // Most recent observations for one category — the sample the nightly job
  // recomputes percentiles from. Bounded because dwell behaviour drifts (a store
  // reorganises, a branch gets busier) and ancient data should not anchor it.
  recentDwellSecondsForCategory(categoryId: number, limit: number) {
    return prisma.dwellObservation.findMany({
      where: { categoryId },
      select: { dwellSeconds: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },

  existsForPinpoint(pinpointId: number) {
    return prisma.dwellObservation.findFirst({ where: { pinpointId }, select: { id: true } });
  },
};
