import { prisma } from "../lib/prisma.js";
import { haversineDistanceKm, type GeoPoint } from "../lib/geo.js";
import { isWithinServiceBuffer } from "../lib/serviceArea.js";
import { logger } from "../lib/logger.js";
import type { GeofencePoint, GeofenceStop } from "./geofenceService.js";

/**
 * Self-healing store location auto-correction engine.
 *
 * When a rider reaches a store and dwells outside it (Option 4), their phone's
 * GPS fix outside the store represents the real-world physical stopping point.
 *
 * This service updates or registers the store in `verified_places` with the rider's
 * true storefront coordinates, permanently turning unverified or middle-of-the-road
 * Google pins into accurate, off-road verified storefronts for all future customer searches.
 */
export const storeAutoCorrectionService = {
  async autoCorrectStoreCoordinates(input: {
    errandId: string;
    stop: GeofenceStop;
    arrivalPoint: GeofencePoint;
  }): Promise<void> {
    const { errandId, stop, arrivalPoint } = input;
    if (
      !Number.isFinite(arrivalPoint.latitude) ||
      !Number.isFinite(arrivalPoint.longitude) ||
      !isWithinServiceBuffer(arrivalPoint, 0.1)
    ) {
      return;
    }

    try {
      const pinpoint = await prisma.errandPinpoint.findUnique({
        where: { id: stop.id },
        select: {
          id: true,
          storeName: true,
          categoryId: true,
          placeId: true,
          latitude: true,
          longitude: true,
        },
      });

      if (!pinpoint || !pinpoint.storeName || !pinpoint.storeName.trim()) {
        return;
      }

      const storeName = pinpoint.storeName.trim();
      const arrivalGeo: GeoPoint = {
        latitude: arrivalPoint.latitude,
        longitude: arrivalPoint.longitude,
      };

      // Case 1: The stop is already linked to a VerifiedPlace row in the database
      if (pinpoint.placeId) {
        const pinnedGeo: GeoPoint = {
          latitude: pinpoint.latitude,
          longitude: pinpoint.longitude,
        };
        const distanceMeters = Math.round(haversineDistanceKm(pinnedGeo, arrivalGeo) * 1000);

        // If the rider stopped between 15m and 120m away (e.g. stopped at the actual building
        // curb, whereas the pinned coordinate was dropped in the middle of the road or junction)
        if (distanceMeters >= 15 && distanceMeters <= 120) {
          await prisma.verifiedPlace.update({
            where: { id: pinpoint.placeId },
            data: {
              latitude: arrivalPoint.latitude,
              longitude: arrivalPoint.longitude,
            },
          });
          logger.info(
            `[StoreAutoCorrection] Refined verified coordinates for "${storeName}" (${pinpoint.placeId}) from rider dwell on errand ${errandId} (adjusted by ${distanceMeters}m).`
          );
        }
        return;
      }

      // Case 2: Stop has no placeId (was selected from Google Places or entered as custom text)
      // Check if a verified place with this exact name already exists
      const existing = await prisma.verifiedPlace.findFirst({
        where: {
          name: storeName,
        },
      });

      if (existing) {
        // Unarchive if inactive, and update coordinates to the rider's true dwell point
        await prisma.verifiedPlace.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            latitude: arrivalPoint.latitude,
            longitude: arrivalPoint.longitude,
            ...(pinpoint.categoryId && !existing.categoryId ? { categoryId: pinpoint.categoryId } : {}),
          },
        });
        await prisma.errandPinpoint.update({
          where: { id: pinpoint.id },
          data: { placeId: existing.id },
        });
        logger.info(
          `[StoreAutoCorrection] Self-healing map: Linked existing store "${storeName}" (${existing.id}) with true rider dwell coordinates from errand ${errandId}.`
        );
        return;
      }

      // Determine an active category id for the new verified store
      let categoryId = pinpoint.categoryId;
      if (!categoryId) {
        const firstCategory = await prisma.merchantCategory.findFirst({
          where: { status: "Active" },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        categoryId = firstCategory?.id ?? 1;
      }

      // Auto-register newly discovered storefront in verified_places
      const created = await prisma.verifiedPlace.create({
        data: {
          name: storeName,
          categoryId,
          address: "Tacurong City",
          latitude: arrivalPoint.latitude,
          longitude: arrivalPoint.longitude,
          isActive: true,
        },
      });

      await prisma.errandPinpoint.update({
        where: { id: pinpoint.id },
        data: { placeId: created.id },
      });

      logger.info(
        `[StoreAutoCorrection] Self-healing map: Auto-registered verified storefront for "${storeName}" (${created.id}) at (${arrivalPoint.latitude}, ${arrivalPoint.longitude}) from errand ${errandId}.`
      );
    } catch (error) {
      logger.warn(
        `[StoreAutoCorrection] Failed to auto-correct store coordinates for stop ${stop.id} on errand ${errandId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
};
