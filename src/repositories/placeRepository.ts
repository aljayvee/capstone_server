import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { haversineDistanceKm, type GeoPoint } from "../lib/geo.js";
import { PlaceCreateInput, PlaceUpdateInput, PlaceSearchFilters, IVerifiedPlace } from "../types/place.js";
import { isPabiliCategoryName } from "../lib/blockedCategoryNames.js";

// One degree of latitude is ~111.32 km everywhere. Longitude degrees shrink with
// latitude, but Tacurong sits at ~6.7°N where cos(lat) is 0.993 — so using the
// latitude figure for both axes over-selects the candidate box by well under a
// percent. That is the safe direction to be wrong in for a pre-filter whose
// results are re-measured exactly afterwards.
const KM_PER_DEGREE = 111.32;

export interface IPlaceRepository {
  findAll(filters?: PlaceSearchFilters): Promise<IVerifiedPlace[]>;
  findById(id: string): Promise<IVerifiedPlace | null>;
  findNearest(
    point: GeoPoint,
    radiusMeters: number
  ): Promise<{ place: IVerifiedPlace; distanceMeters: number } | null>;
  create(data: PlaceCreateInput): Promise<IVerifiedPlace>;
  update(id: string, data: PlaceUpdateInput): Promise<IVerifiedPlace>;
  delete(id: string): Promise<IVerifiedPlace>;
  getCategories(): Promise<{ id: number; name: string; description: string | null }[]>;
  /** Every row, retired too, with what the duplicate check needs (lib/places/placeDuplicates.ts). */
  findAllForDuplicates(): Promise<DirectoryDuplicateRow[]>;
  /** The rows among `ids` or `googlePlaceIds` that carry an owner photo or hours, for the customer lists. */
  findOwnerExtras(ids: string[], googlePlaceIds: string[]): Promise<OwnerExtrasRow[]>;
  getPhoto(id: string): Promise<{ imageData: Uint8Array; mimeType: string; updatedAt: Date } | null>;
  setPhoto(id: string, photo: { imageData: Buffer; mimeType: string; fileSize: number }): Promise<Date>;
  deletePhoto(id: string): Promise<void>;
}

export interface DirectoryDuplicateRow {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  googlePlaceId: string | null;
  isActive: boolean;
  category: { id: number; name: string } | null;
}

export interface OwnerExtrasRow {
  id: string;
  googlePlaceId: string | null;
  openingHours: unknown;
  photoUpdatedAt: Date | null;
  isActive: boolean;
}

/** Prisma's way to write SQL NULL to a Json column; a plain null is refused. */
const jsonOrNull = (value: unknown) => (value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue));

export class PrismaPlaceRepository implements IPlaceRepository {
  async findAll(filters: PlaceSearchFilters = {}): Promise<IVerifiedPlace[]> {
    const { search, categoryId, barangay, limit, includeInactive } = filters;

    const where: any = {};

    // Retired places must not resurface in the store picker. Deactivating a
    // category (seedPlaces.ts) flips isActive on its places, and without this
    // filter a dispatcher could still pin one — e.g. a remittance outlet as a
    // Pabili stop, which the service no longer offers.
    if (!includeInactive) {
      where.isActive = true;
      where.category = { status: "Active" };
    }

    if (categoryId) {
      where.categoryId = categoryId;
    }

    if (barangay) {
      where.barangay = { contains: barangay };
    }

    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { name: { contains: q } },
        { address: { contains: q } },
        { barangay: { contains: q } },
        { keywords: { contains: q } },
        { category: { name: { contains: q } } },
      ];
    }

    return prisma.verifiedPlace.findMany({
      where,
      include: {
        category: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
      orderBy: { name: "asc" },
      take: limit !== undefined ? Math.max(1, Math.min(Number(limit) || 20, 50)) : (search && search.trim() ? 20 : undefined),
    });
  }

  // Nearest active place to a coordinate, or null when nothing is close enough.
  //
  // Two-stage on purpose: MySQL has no spatial index on these plain Float
  // columns, so the bounding box is what keeps this off a full table scan, and
  // the exact great-circle ranking then happens in JS over the handful of rows
  // that survive. A box is a square and a radius is a circle, so a row can clear
  // the box and still be outside the radius — the haversine filter below is what
  // makes the result actually circular.
  async findNearest(
    point: GeoPoint,
    radiusMeters: number
  ): Promise<{ place: IVerifiedPlace; distanceMeters: number } | null> {
    const radiusDegrees = radiusMeters / 1000 / KM_PER_DEGREE;

    const candidates = await prisma.verifiedPlace.findMany({
      where: {
        // Same visibility guard as findAll: a retired place, or one under a
        // retired category, must not surface as somebody's delivery address.
        isActive: true,
        category: { status: "Active" },
        latitude: { gte: point.latitude - radiusDegrees, lte: point.latitude + radiusDegrees },
        longitude: { gte: point.longitude - radiusDegrees, lte: point.longitude + radiusDegrees },
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
    });

    let best: { place: IVerifiedPlace; distanceMeters: number } | null = null;

    for (const place of candidates) {
      const distanceMeters = haversineDistanceKm(point, place) * 1000;
      if (distanceMeters > radiusMeters) continue;
      if (!best || distanceMeters < best.distanceMeters) {
        best = { place, distanceMeters };
      }
    }

    return best;
  }

  async findById(id: string): Promise<IVerifiedPlace | null> {
    return prisma.verifiedPlace.findUnique({
      where: { id },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
    });
  }

  async create(data: PlaceCreateInput): Promise<IVerifiedPlace> {
    return prisma.verifiedPlace.create({
      data: {
        name: data.name,
        categoryId: data.categoryId,
        address: data.address,
        barangay: data.barangay ?? null,
        latitude: data.latitude,
        longitude: data.longitude,
        keywords: data.keywords ?? null,
        isActive: data.isActive ?? true,
        googlePlaceId: data.googlePlaceId ?? null,
        ownerPinned: data.ownerPinned ?? false,
        ...(data.openingHours ? { openingHours: data.openingHours as unknown as Prisma.InputJsonValue } : {}),
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
    });
  }

  async update(id: string, data: PlaceUpdateInput): Promise<IVerifiedPlace> {
    return prisma.verifiedPlace.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.categoryId !== undefined && { categoryId: data.categoryId }),
        ...(data.address !== undefined && { address: data.address }),
        ...(data.barangay !== undefined && { barangay: data.barangay }),
        ...(data.latitude !== undefined && { latitude: data.latitude }),
        ...(data.longitude !== undefined && { longitude: data.longitude }),
        ...(data.keywords !== undefined && { keywords: data.keywords }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.googlePlaceId !== undefined && { googlePlaceId: data.googlePlaceId }),
        ...(data.ownerPinned !== undefined && { ownerPinned: data.ownerPinned }),
        ...(data.openingHours !== undefined && { openingHours: jsonOrNull(data.openingHours) }),
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
    });
  }

  async delete(id: string): Promise<IVerifiedPlace> {
    return prisma.verifiedPlace.delete({
      where: { id },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
    });
  }

  async getCategories() {
    const rows = await prisma.merchantCategory.findMany({
      where: { status: "Active" },
      select: { id: true, name: true, description: true },
      orderBy: { name: "asc" },
    });
    return rows.filter((c) => isPabiliCategoryName(c.name));
  }

  async findAllForDuplicates(): Promise<DirectoryDuplicateRow[]> {
    return prisma.verifiedPlace.findMany({
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        googlePlaceId: true,
        isActive: true,
        category: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async findOwnerExtras(ids: string[], googlePlaceIds: string[]): Promise<OwnerExtrasRow[]> {
    if (ids.length === 0 && googlePlaceIds.length === 0) return [];
    return prisma.verifiedPlace.findMany({
      where: {
        OR: [
          ...(ids.length ? [{ id: { in: ids } }] : []),
          ...(googlePlaceIds.length ? [{ googlePlaceId: { in: googlePlaceIds } }] : []),
        ],
      },
      select: { id: true, googlePlaceId: true, openingHours: true, photoUpdatedAt: true, isActive: true },
    });
  }

  async getPhoto(id: string) {
    return prisma.verifiedPlacePhoto.findUnique({
      where: { placeId: id },
      select: { imageData: true, mimeType: true, updatedAt: true },
    });
  }

  async setPhoto(id: string, photo: { imageData: Buffer; mimeType: string; fileSize: number }): Promise<Date> {
    const at = new Date();
    await prisma.$transaction([
      prisma.verifiedPlacePhoto.upsert({
        where: { placeId: id },
        create: { placeId: id, ...photo },
        update: photo,
      }),
      prisma.verifiedPlace.update({ where: { id }, data: { photoUpdatedAt: at } }),
    ]);
    return at;
  }

  async deletePhoto(id: string): Promise<void> {
    await prisma.$transaction([
      prisma.verifiedPlacePhoto.deleteMany({ where: { placeId: id } }),
      prisma.verifiedPlace.update({ where: { id }, data: { photoUpdatedAt: null } }),
    ]);
  }
}

export const placeRepository = new PrismaPlaceRepository();
