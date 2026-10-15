import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  errandPinpoint: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  verifiedPlace: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  merchantCategory: {
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: mockPrisma,
}));

vi.mock("../src/lib/serviceArea.js", () => ({
  isWithinServiceBuffer: (p: { latitude: number; longitude: number }) =>
    p.latitude >= 6.6 && p.latitude <= 6.8 && p.longitude >= 124.6 && p.longitude <= 124.8,
}));

import { storeAutoCorrectionService } from "../src/services/storeAutoCorrectionService.js";

describe("storeAutoCorrectionService (Option 4 - Self-Healing Map)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refines verifiedPlace coordinates when rider dwells between 15m and 120m from an existing pinned place", async () => {
    // Pinned location at road centerline (6.69000, 124.68000)
    mockPrisma.errandPinpoint.findUnique.mockResolvedValueOnce({
      id: 101,
      storeName: "Terickfic Special Buko Pie",
      categoryId: 4,
      placeId: "place-uuid-1",
      latitude: 6.69000,
      longitude: 124.68000,
    });
    mockPrisma.verifiedPlace.update.mockResolvedValueOnce({ id: "place-uuid-1" });

    // Rider actually stopped at true curb/storefront ~35 meters away (6.69030, 124.68010)
    await storeAutoCorrectionService.autoCorrectStoreCoordinates({
      errandId: "errand-test-1",
      stop: {
        id: 101,
        latitude: 6.69000,
        longitude: 124.68000,
        categoryId: 4,
        placeId: "place-uuid-1",
        arrivedAt: null,
        departedAt: null,
      },
      arrivalPoint: {
        latitude: 6.69030,
        longitude: 124.68010,
        recordedAt: new Date(),
      },
    });

    expect(mockPrisma.verifiedPlace.update).toHaveBeenCalledWith({
      where: { id: "place-uuid-1" },
      data: {
        latitude: 6.69030,
        longitude: 124.68010,
      },
    });
  });

  it("auto-registers a newly discovered storefront in verified_places when placeId is null", async () => {
    mockPrisma.errandPinpoint.findUnique.mockResolvedValueOnce({
      id: 202,
      storeName: "Janno's Eatery",
      categoryId: 2,
      placeId: null,
      latitude: 6.69167,
      longitude: 124.67362,
    });
    mockPrisma.verifiedPlace.findFirst.mockResolvedValueOnce(null);
    mockPrisma.verifiedPlace.create.mockResolvedValueOnce({
      id: "new-place-uuid",
      name: "Janno's Eatery",
      categoryId: 2,
    });
    mockPrisma.errandPinpoint.update.mockResolvedValueOnce({ id: 202 });

    await storeAutoCorrectionService.autoCorrectStoreCoordinates({
      errandId: "errand-test-2",
      stop: {
        id: 202,
        latitude: 6.69167,
        longitude: 124.67362,
        categoryId: 2,
        placeId: null,
        arrivedAt: null,
        departedAt: null,
      },
      arrivalPoint: {
        latitude: 6.69185,
        longitude: 124.67380,
        recordedAt: new Date(),
      },
    });

    expect(mockPrisma.verifiedPlace.create).toHaveBeenCalledWith({
      data: {
        name: "Janno's Eatery",
        categoryId: 2,
        address: "Tacurong City",
        latitude: 6.69185,
        longitude: 124.67380,
        isActive: true,
      },
    });
    expect(mockPrisma.errandPinpoint.update).toHaveBeenCalledWith({
      where: { id: 202 },
      data: { placeId: "new-place-uuid" },
    });
  });

  it("ignores fixes outside Tacurong service buffer", async () => {
    await storeAutoCorrectionService.autoCorrectStoreCoordinates({
      errandId: "errand-out-of-bounds",
      stop: {
        id: 303,
        latitude: 7.50000,
        longitude: 125.50000,
        categoryId: 1,
        placeId: null,
        arrivedAt: null,
        departedAt: null,
      },
      arrivalPoint: {
        latitude: 7.50000,
        longitude: 125.50000,
        recordedAt: new Date(),
      },
    });

    expect(mockPrisma.errandPinpoint.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.verifiedPlace.create).not.toHaveBeenCalled();
  });
});
