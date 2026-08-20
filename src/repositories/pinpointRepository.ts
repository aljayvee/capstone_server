import { prisma } from "../lib/prisma.js";

export interface PinpointInput {
  storeName: string;
  latitude: number;
  longitude: number;
  // Resolved from the matched VerifiedPlace where the dispatcher picked one
  // from the catalogue. Drives the ETA's per-category dwell allowance, so a
  // pin dropped on a bare map (no category) falls back to a generic estimate.
  categoryId?: number | null;
  placeId?: string | null;
  sequenceLocked?: boolean;
}

export const pinpointRepository = {
  findByErrandId(errandId: string) {
    return prisma.errandPinpoint.findMany({ where: { errandId }, orderBy: { sequence: "asc" } });
  },

  // Pinpoints plus the dwell priors for their category — everything the ETA
  // engine needs about the remaining stops in one read.
  findByErrandIdWithCategory(errandId: string) {
    return prisma.errandPinpoint.findMany({
      where: { errandId },
      orderBy: { sequence: "asc" },
      include: {
        category: {
          select: { id: true, name: true, dwellP50Seconds: true, dwellP80Seconds: true, dwellSampleCount: true },
        },
      },
    });
  },

  markArrived(pinpointId: number, arrivedAt: Date) {
    return prisma.errandPinpoint.update({ where: { id: pinpointId }, data: { arrivedAt } });
  },

  markDeparted(pinpointId: number, departedAt: Date) {
    return prisma.errandPinpoint.update({ where: { id: pinpointId }, data: { departedAt } });
  },

  setLegMetrics(pinpointId: number, distanceMeters: number, durationSeconds: number) {
    return prisma.errandPinpoint.update({
      where: { id: pinpointId },
      data: { legDistanceMeters: distanceMeters, legDurationSeconds: durationSeconds },
    });
  },

  reorder(updates: Array<{ id: number; sequence: number }>) {
    return prisma.$transaction(
      updates.map((update) =>
        prisma.errandPinpoint.update({ where: { id: update.id }, data: { sequence: update.sequence } })
      )
    );
  },

  // Atomic replace-all: delete existing pins then insert the new set in one
  // transaction, so a dispatcher re-saving pins never leaves stale rows mixed in.
  replaceForErrand(errandId: string, pins: PinpointInput[]) {
    return prisma.$transaction([
      prisma.errandPinpoint.deleteMany({ where: { errandId } }),
      prisma.errandPinpoint.createMany({
        data: pins.map((pin, index) => ({
          errandId,
          sequence: index,
          storeName: pin.storeName,
          latitude: pin.latitude,
          longitude: pin.longitude,
          categoryId: pin.categoryId ?? null,
          placeId: pin.placeId ?? null,
          sequenceLocked: pin.sequenceLocked ?? false,
        })),
      }),
    ]);
  },
};
