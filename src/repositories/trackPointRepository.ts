import { prisma } from "../lib/prisma.js";

export interface TrackPointCreateData {
  errandId: string;
  riderId: number;
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  recordedAt: Date;
  isMapMatched: boolean;
  wasOffline: boolean;
  clientPointId: string;
}

export const trackPointRepository = {
  // skipDuplicates leans on the [errandId, clientPointId] unique index so a
  // batch the client retries after a timeout — having never seen our response —
  // is absorbed silently instead of duplicating the trail.
  createMany(points: TrackPointCreateData[]) {
    return prisma.errandTrackPoint.createMany({ data: points, skipDuplicates: true });
  },

  listForErrand(errandId: string) {
    return prisma.errandTrackPoint.findMany({
      where: { errandId },
      orderBy: { recordedAt: "asc" },
    });
  },

  // Newest accepted fix for a rider, used to rebuild the in-process position
  // cache after a restart and to sanity-check incoming points against.
  findLatestForRider(riderId: number) {
    return prisma.errandTrackPoint.findFirst({
      where: { riderId },
      orderBy: { recordedAt: "desc" },
    });
  },

  // Retention: the trail is only needed while a delivery can still be disputed.
  deleteForCompletedErrandsBefore(cutoff: Date) {
    return prisma.errandTrackPoint.deleteMany({
      where: {
        errand: {
          status: { in: ["COMPLETED", "CANCELLED"] },
          updatedAt: { lt: cutoff },
        },
      },
    });
  },
};
