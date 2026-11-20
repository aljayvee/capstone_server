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

  // The trail for the staff route replay, oldest first. Selects only what the
  // replay draws (no id, no clientPointId) and stops at `take`, so a runaway
  // trail cannot load unbounded rows; the caller asks for one more than it
  // returns to learn whether it was cut short.
  listForReplay(errandId: string, take: number) {
    return prisma.errandTrackPoint.findMany({
      where: { errandId },
      orderBy: { recordedAt: "asc" },
      take,
      select: {
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        speedMps: true,
        headingDeg: true,
        recordedAt: true,
        receivedAt: true,
        isMapMatched: true,
        wasOffline: true,
        riderId: true,
      },
    });
  },

  // Newest accepted fix for a rider, used to rebuild the in-process position
  // cache after a restart and to sanity-check incoming points against.
  // Scoped to ONE errand, not to the rider's whole history.
  //
  // Unscoped, the anchor could be the last fix of a previous errand finished
  // across town hours earlier — against which the first fix of a new errand
  // looks like a teleport and is rejected, taking the rest of the batch with it.
  // A trail is per-errand; the fix before the first one of an errand is not a
  // predecessor in any useful sense.
  findLatestForRider(riderId: number, errandId?: string) {
    return prisma.errandTrackPoint.findFirst({
      where: { riderId, ...(errandId ? { errandId } : {}) },
      orderBy: { recordedAt: "desc" },
    });
  },

  // The stored trail inside a time window and a lat/lng box: whether the rider
  // was ever seen near one stop since arriving there (geofenceService). The box
  // is a cheap prefilter on the [errandId, recordedAt] index; the caller does
  // the exact distance and attribution.
  findInWindowNear(
    errandId: string,
    from: Date,
    until: Date,
    box: { minLatitude: number; maxLatitude: number; minLongitude: number; maxLongitude: number },
    take = 50
  ) {
    return prisma.errandTrackPoint.findMany({
      where: {
        errandId,
        recordedAt: { gte: from, lt: until },
        latitude: { gte: box.minLatitude, lte: box.maxLatitude },
        longitude: { gte: box.minLongitude, lte: box.maxLongitude },
      },
      orderBy: { recordedAt: "asc" },
      take,
      select: { latitude: true, longitude: true, recordedAt: true },
    });
  },

  // The stored fix closest in time to a moment, from either side of it: where
  // the phone put the rider then. Null when the errand has no trail at all.
  async findNearestInTime(errandId: string, at: Date) {
    const select = { latitude: true, longitude: true, recordedAt: true } as const;
    const [before, after] = await Promise.all([
      prisma.errandTrackPoint.findFirst({
        where: { errandId, recordedAt: { lte: at } },
        orderBy: { recordedAt: "desc" },
        select,
      }),
      prisma.errandTrackPoint.findFirst({
        where: { errandId, recordedAt: { gt: at } },
        orderBy: { recordedAt: "asc" },
        select,
      }),
    ]);
    if (!before) return after;
    if (!after) return before;
    return at.getTime() - before.recordedAt.getTime() <= after.recordedAt.getTime() - at.getTime() ? before : after;
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
