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
    return prisma.errandPinpoint.findMany({
      where: { errandId },
      orderBy: { sequence: "asc" },
      // The category is read only for its geofence radius. A pin dropped
      // outside the catalogue has none, and the geofence falls back to its
      // default for that stop.
      include: { category: { select: { geofenceRadiusMeters: true, dwellP80Seconds: true } } },
    });
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

  // Records that the rider settled at a catalogue place other than the one this
  // stop was pinned to (see geofenceService.detectStopMismatch). Purely
  // observational — it never touches arrivedAt, so the stop stays outstanding
  // and the rider can still complete it properly.
  markStopMismatch(pinpointId: number, observedPlaceId: string, detectedAt: Date) {
    return prisma.errandPinpoint.update({
      where: { id: pinpointId },
      data: { observedPlaceId, mismatchDetectedAt: detectedAt },
    });
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

  // Each stop with the number of receipt photos filed against it. A stop with
  // any is evidence of money spent there, and replaceForErrand would orphan
  // those photos (pinpointId SET NULL), so savePinpoints checks this first.
  findWithProofCounts(errandId: string) {
    return prisma.errandPinpoint.findMany({
      where: { errandId },
      orderBy: { sequence: "asc" },
      select: {
        id: true,
        storeName: true,
        latitude: true,
        longitude: true,
        placeId: true,
        _count: { select: { proofImages: true } },
      },
    });
  },

  // replaceForErrand for an errand whose stops already carry evidence.
  // keepIds[i] is the existing row pins[i] continues, or null for a new stop.
  // Kept rows are updated in place, so their id (and every receipt, arrival
  // stamp and dwell observation hanging off it) survives; every other existing
  // row is deleted, the same as the replace-all path. One transaction.
  replaceForErrandKeeping(errandId: string, pins: PinpointInput[], keepIds: Array<number | null>) {
    const kept = keepIds.filter((id): id is number => id !== null);
    return prisma.$transaction([
      prisma.errandPinpoint.deleteMany({ where: { errandId, id: { notIn: kept } } }),
      ...pins.map((pin, index) => {
        const id = keepIds[index];
        const data = {
          sequence: index,
          categoryId: pin.categoryId ?? null,
          placeId: pin.placeId ?? null,
          sequenceLocked: pin.sequenceLocked ?? false,
        };
        return id !== null && id !== undefined
          ? prisma.errandPinpoint.update({ where: { id }, data })
          : prisma.errandPinpoint.create({
              data: { errandId, storeName: pin.storeName, latitude: pin.latitude, longitude: pin.longitude, ...data },
            });
      }),
    ]);
  },
};
