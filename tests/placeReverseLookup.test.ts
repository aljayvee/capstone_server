import { beforeEach, describe, expect, it, vi } from "vitest";

// Rows the fake Prisma layer will serve. Coordinates are the real downtown
// cluster from the catalogue, which is the point: these places are 25-110 m
// apart, so the radius and the nearest-wins tie-break are doing real work here,
// not guarding a hypothetical.
const ROWS = [
  { id: "jollibee-main", name: "Jollibee Tacurong Center (Main)", latitude: 6.6873, longitude: 124.6752 },
  { id: "greenwich", name: "Greenwich Tacurong", latitude: 6.6869, longitude: 124.6745 },
  { id: "chowking", name: "Chowking Tacurong", latitude: 6.6865, longitude: 124.6749 },
  { id: "mang-inasal", name: "Mang Inasal Tacurong", latitude: 6.6881, longitude: 124.6758 },
];

const findMany = vi.fn();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { verifiedPlace: { findMany: (args: unknown) => findMany(args) } },
}));

const { placeService } = await import("../src/services/placeService.js");

// Mirrors the repository's bounding-box pre-filter so the fake behaves like the
// database: the service must still be the thing that enforces the circular
// radius, since a box is not a circle.
function serveBoundingBox(args: any) {
  const { latitude, longitude } = args.where;
  return ROWS.filter(
    (row) =>
      row.latitude >= latitude.gte &&
      row.latitude <= latitude.lte &&
      row.longitude >= longitude.gte &&
      row.longitude <= longitude.lte
  );
}

beforeEach(() => {
  findMany.mockReset();
  findMany.mockImplementation((args: any) => Promise.resolve(serveBoundingBox(args)));
});

describe("placeService.reverseLookup", () => {
  it("names the establishment a pin is sitting on", async () => {
    const match = await placeService.reverseLookup({ latitude: 6.6873, longitude: 124.6752 });
    expect(match?.place.name).toBe("Jollibee Tacurong Center (Main)");
    expect(match?.distanceMeters).toBeLessThan(1);
  });

  it("returns the nearest when several are in range", async () => {
    // Nudged towards Greenwich from Jollibee. Both are inside the box; only the
    // exact ranking can tell them apart.
    const match = await placeService.reverseLookup({ latitude: 6.687, longitude: 124.6746 });
    expect(match?.place.name).toBe("Greenwich Tacurong");
  });

  it("returns null for a pin that is merely nearby", async () => {
    // ~330 m north of Jollibee — on a residential street, not at a restaurant.
    // This is the case that matters most: a customer's home must not be labelled
    // with the name of a business down the road.
    const match = await placeService.reverseLookup({ latitude: 6.6903, longitude: 124.6752 });
    expect(match).toBeNull();
  });

  it("excludes retired places and retired categories at the query", async () => {
    await placeService.reverseLookup({ latitude: 6.6873, longitude: 124.6752 });
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      isActive: true,
      category: { status: "Active" },
    });
  });

  it("does not query at all outside the service area", async () => {
    const match = await placeService.reverseLookup({ latitude: 14.5995, longitude: 120.9842 });
    expect(match).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("bounds the query rather than scanning the table", async () => {
    // These columns carry no spatial index, so the bounding box is the only
    // thing keeping this off a full scan as the catalogue grows.
    await placeService.reverseLookup({ latitude: 6.6873, longitude: 124.6752 });
    const where = findMany.mock.calls[0][0].where;
    expect(where.latitude.gte).toBeLessThan(6.6873);
    expect(where.latitude.lte).toBeGreaterThan(6.6873);
    expect(where.longitude.gte).toBeLessThan(124.6752);
    expect(where.longitude.lte).toBeGreaterThan(124.6752);
  });
});
