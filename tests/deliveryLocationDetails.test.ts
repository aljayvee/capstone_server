import { beforeEach, describe, expect, it, vi } from "vitest";

// Street name, landmark and rider notes: saved on the customer's location,
// copied onto the errand, and read by the rider at the door. These pin the
// three meanings an update has to keep apart (omitted, cleared, set) and that
// the errand stores its own copy.

vi.mock("../src/repositories/locationRepository.js", () => ({
  locationRepository: {
    countByCustomerId: vi.fn(async () => 1),
    create: vi.fn(async (_customerId: number, data: unknown) => data),
    updateWithOptionalDefault: vi.fn(async (_id: number, _customerId: number, data: unknown) => data),
  },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    create: vi.fn(async (data: Record<string, unknown>) => ({ id: "e1", pabiliDetails: [], ...data })),
  },
  dispatchLogRepository: {},
}));
vi.mock("../src/repositories/rateConfigRepository.js", () => ({
  rateConfigRepository: { findFirst: vi.fn(async () => null) },
}));
vi.mock("../src/repositories/customerTransactionRepository.js", () => ({
  customerTransactionRepository: { create: vi.fn(async () => ({})) },
}));
vi.mock("../src/services/patterns/categoryFeeModes.js", () => ({
  modesForCategoryNames: vi.fn(async () => []),
  resolveCategoryModes: vi.fn(async () => []),
}));
vi.mock("../src/lib/category/categoryServiceClient.js", () => ({
  warmItemCategories: vi.fn(),
}));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrandParties: vi.fn(), emitToCustomer: vi.fn() },
}));
vi.mock("../src/lib/serviceArea.js", () => ({
  isServiceAreaConfigured: () => false,
  isWithinServiceArea: () => true,
  isWithinServiceBuffer: () => true,
}));

import { locationSchema } from "../src/validators/locationValidators.js";
import { createErrandSchema } from "../src/validators/errandValidators.js";
import { locationRepository } from "../src/repositories/locationRepository.js";
import { errandRepository } from "../src/repositories/errandRepository.js";
import * as locationService from "../src/services/locationService.js";
import { createErrand } from "../src/services/errandService.js";

const PIN = { label: "Home", address: "Purok 5, Tacurong", latitude: 6.69, longitude: 124.68 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saved location details", () => {
  it("leaves omitted details undefined, so an update does not touch them", () => {
    const parsed = locationSchema.parse({ ...PIN, isDefault: true });
    expect(parsed.streetName).toBeUndefined();
    expect(parsed.landmark).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
  });

  it("stores a cleared box as null, not an empty string", () => {
    const parsed = locationSchema.parse({ ...PIN, streetName: "   ", landmark: "", notes: null });
    expect(parsed.streetName).toBeNull();
    expect(parsed.landmark).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  it("trims what the customer typed", () => {
    const parsed = locationSchema.parse({
      ...PIN,
      streetName: "  Rizal Street ",
      landmark: " Blue gate beside the sari-sari store ",
      notes: " Call when outside ",
    });
    expect(parsed).toMatchObject({
      streetName: "Rizal Street",
      landmark: "Blue gate beside the sari-sari store",
      notes: "Call when outside",
    });
  });

  it("refuses details longer than their columns", () => {
    expect(() => locationSchema.parse({ ...PIN, streetName: "x".repeat(151) })).toThrow();
    expect(() => locationSchema.parse({ ...PIN, landmark: "x".repeat(201) })).toThrow();
    expect(() => locationSchema.parse({ ...PIN, notes: "x".repeat(301) })).toThrow();
  });

  it("saves the details with a new location", async () => {
    await locationService.createLocation(42, locationSchema.parse({ ...PIN, landmark: "Near the chapel" }));
    expect(locationRepository.create).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ landmark: "Near the chapel", streetName: undefined, notes: undefined }),
      false
    );
  });

  it("keeps stored details when 'Set as default' sends only the pin", async () => {
    await locationService.updateLocation(9, 42, locationSchema.parse({ ...PIN, isDefault: true }));
    const data = vi.mocked(locationRepository.updateWithOptionalDefault).mock.calls[0][2];
    // Prisma reads undefined as "leave this column alone".
    expect(data.streetName).toBeUndefined();
    expect(data.landmark).toBeUndefined();
    expect(data.notes).toBeUndefined();
  });
});

describe("errand delivery details", () => {
  it("copies the details onto the errand it creates", async () => {
    const input = createErrandSchema.parse({
      deliveryAddress: "Purok 5, Tacurong",
      deliveryLatitude: 6.69,
      deliveryLongitude: 124.68,
      deliveryStreetName: " Rizal Street ",
      deliveryLandmark: "Blue gate",
      deliveryNotes: "Call when outside",
    });
    await createErrand(42, input);
    expect(errandRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryStreetName: "Rizal Street",
        deliveryLandmark: "Blue gate",
        deliveryNotes: "Call when outside",
      })
    );
  });

  it("stores null when an older app sends none of them", async () => {
    await createErrand(42, createErrandSchema.parse({ deliveryAddress: "Purok 5, Tacurong" }));
    expect(errandRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryStreetName: null,
        deliveryLandmark: null,
        deliveryNotes: null,
      })
    );
  });
});
