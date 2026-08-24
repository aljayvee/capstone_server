import { prisma } from "../lib/prisma.js";
import { haversineDistanceKm, type GeoPoint } from "../lib/geo.js";
import { PlaceCreateInput, PlaceUpdateInput, PlaceSearchFilters, IVerifiedPlace } from "../types/place.js";

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
}

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
      take: limit ? Number(limit) : undefined,
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
    return prisma.merchantCategory.findMany({
      where: { status: "Active" },
      select: { id: true, name: true, description: true },
      orderBy: { name: "asc" },
    });
  }
}

export const placeRepository = new PrismaPlaceRepository();
