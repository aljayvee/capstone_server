import { prisma } from "../lib/prisma.js";

export interface PresenceWrite {
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  headingDeg?: number | null;
  onDuty: boolean;
  backgroundLocation: boolean;
  notifications: boolean;
  exactAlarms: boolean;
  beaconIntervalMs?: number | null;
  connectivity?: string | null;
  recordedAt?: Date | null;
  lastBeaconAt: Date;
  shutdownAt?: Date | null;
}

export const riderPresenceRepository = {
  findByRiderId(riderId: number) {
    return prisma.riderPresence.findUnique({ where: { riderId } });
  },

  // Every rider's current state in one query — dispatch reads the whole fleet
  // per assignment, and N round trips for N riders is how that becomes the
  // slowest thing in the request.
  findMany(riderIds: number[]) {
    return prisma.riderPresence.findMany({ where: { riderId: { in: riderIds } } });
  },

  upsert(riderId: number, data: PresenceWrite) {
    return prisma.riderPresence.upsert({
      where: { riderId },
      create: { riderId, ...data },
      update: data,
    });
  },

  // Called on logout so a signed-out rider cannot linger as dispatchable on a
  // beacon that arrived seconds before they signed out.
  clearForRider(riderId: number) {
    return prisma.riderPresence.updateMany({
      where: { riderId },
      data: { onDuty: false, shutdownAt: new Date() },
    });
  },
};
