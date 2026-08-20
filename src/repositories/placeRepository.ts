import { prisma } from "../lib/prisma.js";
import { PlaceCreateInput, PlaceUpdateInput, PlaceSearchFilters, IVerifiedPlace } from "../types/place.js";

export interface IPlaceRepository {
  findAll(filters?: PlaceSearchFilters): Promise<IVerifiedPlace[]>;
  findById(id: string): Promise<IVerifiedPlace | null>;
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
