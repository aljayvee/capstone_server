import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The customer app's "Location" store picker (2026-10-08): the owner's Location
 * Stores plus Google Places, one list, each shop once, with a merchant category
 * worked out for every Google row.
 */

const google = vi.hoisted(() => ({
  nearby: null as unknown[] | null,
  text: null as unknown[] | null,
  /** The popular search's answer for one group of types; null when Google cannot answer. */
  popular: null as null | ((types: string[]) => unknown[] | null),
  configured: true,
}));
const catalogue = vi.hoisted(() => ({ rows: [] as unknown[] }));
const history = vi.hoisted(() => ({ pins: [] as unknown[], fail: false }));

// The billed Google photo lookup, answered here: one address per named photo.
vi.mock("../src/lib/places/placePhotos.js", () => ({
  resolvePhotoUris: vi.fn(async (names: Array<string | null>) =>
    names.map((name) => (name ? `https://lh3.googleusercontent.com/${name}` : null))
  ),
}));

/** Location Stores with the owner's photo or hours (placeRepository.findOwnerExtras). */
const owners = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    verifiedPlace: { findMany: vi.fn(async () => owners.rows) },
    errandPinpoint: {
      findMany: vi.fn(async () => {
        if (history.fail) throw new Error("database unreachable");
        return history.pins;
      }),
    },
  },
}));
const model = vi.hoisted(() => ({ answer: null as null | { id: number; name: string }, delayMs: 0 }));

vi.mock("../src/lib/places/googlePlacesClient.js", async (original) => ({
  ...(await original<typeof import("../src/lib/places/googlePlacesClient.js")>()),
  isGooglePlacesConfigured: () => google.configured,
  searchNearbyPlaces: vi.fn(async () => google.nearby),
  searchPlacesByText: vi.fn(async () => google.text),
  searchPopularPlaces: vi.fn(async (_centre: unknown, types: string[]) => (google.popular ? google.popular(types) : null)),
}));
vi.mock("../src/services/placeService.js", () => ({
  placeService: { searchPlaces: vi.fn(async () => catalogue.rows) },
}));
vi.mock("../src/repositories/merchantCategoryRepository.js", () => ({
  merchantCategoryRepository: {
    findMany: vi.fn(async () => [
      { id: 1, name: "Fast Food" },
      { id: 2, name: "Restaurant" },
      { id: 3, name: "Pharmacy" },
      { id: 4, name: "Bread & Pastry" },
      { id: 5, name: "Supermarket & Grocery" },
      { id: 6, name: "Convenience Store" },
      { id: 7, name: "Retail & General Merchandise" },
    ]),
  },
}));
vi.mock("../src/services/categoryInferenceService.js", () => ({
  inferStoreCategory: vi.fn(async () => {
    if (model.delayMs) await new Promise((resolve) => setTimeout(resolve, model.delayMs));
    return model.answer
      ? { available: true, categoryId: model.answer.id, categoryName: model.answer.name }
      : { available: false, reason: "down" };
  }),
}));
vi.mock("../src/lib/serviceArea.js", () => ({
  isWithinServiceBuffer: (p: { latitude: number }) => p.latitude > 6.6 && p.latitude < 6.8,
  isWithinServiceArea: () => true,
  serviceAreaEnvelope: () => ({ minLat: 6.6, maxLat: 6.8, minLng: 124.6, maxLng: 124.8 }),
  SERVICE_AREA_CENTRE: { latitude: 6.671, longitude: 124.6644 },
}));
vi.mock("../src/services/storePredictionService.js", async () => {
  // The real normaliser, without loading the predictor's database memory.
  return {
    normalizeStoreName: (raw: string) =>
      String(raw ?? "")
        .toLowerCase()
        .split(",")[0]
        .replace(/[^a-z0-9\s]+/g, " ")
        .replace(/\b(tacurong( city)?|sultan kudarat)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
  };
});

import { toPlaces } from "../src/lib/places/googlePlacesClient.js";
import { categoryForGoogleTypes, categorizeGooglePlaces } from "../src/lib/places/establishmentCategory.js";
import {
  clearPopularPool,
  fromCatalogue,
  fromGoogle,
  mergeEstablishments,
  popularEstablishments,
  searchEstablishments,
  tallyStoreHistory,
  withoutPlusCode,
  type Establishment,
  type PastOrderPin,
} from "../src/services/establishmentService.js";

const ACTIVE = [
  { id: 1, name: "Fast Food" },
  { id: 2, name: "Restaurant" },
  { id: 3, name: "Pharmacy" },
  { id: 4, name: "Bread & Pastry" },
  { id: 5, name: "Supermarket & Grocery" },
  { id: 6, name: "Convenience Store" },
  { id: 7, name: "Retail & General Merchandise" },
];

const raw = (id: string, name: string, lat: number, types: string[] = ["store"], extra: object = {}) => ({
  id,
  displayName: { text: name },
  shortFormattedAddress: "Poblacion, Tacurong",
  location: { latitude: lat, longitude: 124.68 },
  types,
  primaryType: types[0],
  ...extra,
});

const place = (id: string, name: string, lat: number, categoryId = 3, categoryName = "Pharmacy") => ({
  id,
  name,
  categoryId,
  category: { id: categoryId, name: categoryName },
  address: "Mabini St",
  barangay: "Poblacion",
  latitude: lat,
  longitude: 124.68,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

beforeEach(() => {
  google.nearby = null;
  google.text = null;
  google.popular = null;
  google.configured = true;
  catalogue.rows = [];
  history.pins = [];
  history.fail = false;
  owners.rows = [];
  model.answer = null;
  model.delayMs = 0;
  clearPopularPool();
});

describe("Google's answer", () => {
  it("keeps open shops inside the city and nothing else", () => {
    const places = toPlaces([
      raw("a", "Mercury Drug", 6.69, ["pharmacy"]),
      raw("b", "Closed Bakery", 6.69, ["bakery"], { businessStatus: "CLOSED_PERMANENTLY" }),
      raw("c", "Koronadal Mall", 6.5, ["shopping_mall"]),
      { id: "d", location: { latitude: 6.69, longitude: 124.68 } },
    ]);
    expect(places.map((p) => p.name)).toEqual(["Mercury Drug"]);
    expect(places[0]).toMatchObject({ googlePlaceId: "a", address: "Poblacion, Tacurong", primaryType: "pharmacy" });
    expect(places[0].photo).toBeNull();
  });

  it("keeps each shop's first photo and who took it, for the Home tab's cards", () => {
    const [shop] = toPlaces([
      raw("a", "Mercury Drug", 6.69, ["pharmacy"], {
        photos: [
          { name: "places/a/photos/first", authorAttributions: [{ displayName: "Juan Dela Cruz" }] },
          { name: "places/a/photos/second" },
        ],
      }),
    ]);
    expect(shop.photo).toEqual({ name: "places/a/photos/first", attribution: "Juan Dela Cruz" });
    const row = fromGoogle(shop, null, null);
    expect(row).toMatchObject({ photoName: "places/a/photos/first", photoAttribution: "Juan Dela Cruz" });
    // The owner's Location Stores have no Google photo.
    expect(fromCatalogue(place("p1", "Rose Pharmacy", 6.69), null)).toMatchObject({ photoName: null, photoAttribution: null });
  });

  it("skips vertical portrait selfies, square avatars, and tiny thumbnails to pick the first landscape storefront photo", () => {
    const [shopWithLandscapeFallback, shopWithSelfieOnly] = toPlaces([
      raw("a", "Jollibee Tacurong", 6.69, ["fast_food_restaurant"], {
        photos: [
          { name: "places/a/photos/portrait-selfie", widthPx: 1080, heightPx: 1920, authorAttributions: [{ displayName: "Selfie User" }] },
          { name: "places/a/photos/square-avatar", widthPx: 800, heightPx: 800, authorAttributions: [{ displayName: "Avatar User" }] },
          { name: "places/a/photos/tiny-thumb", widthPx: 300, heightPx: 200 },
          { name: "places/a/photos/storefront-landscape", widthPx: 1600, heightPx: 1000, authorAttributions: [{ displayName: "Store Owner" }] },
        ],
      }),
      raw("b", "Corner Sari-Sari", 6.691, ["convenience_store"], {
        photos: [
          { name: "places/b/photos/man-portrait", widthPx: 900, heightPx: 1200 },
        ],
      }),
    ]);
    expect(shopWithLandscapeFallback.photo).toEqual({
      name: "places/a/photos/storefront-landscape",
      attribution: "Store Owner",
    });
    expect(shopWithSelfieOnly.photo).toEqual({
      name: "places/b/photos/man-portrait",
      attribution: null,
    });
  });

  it("marks a shop open unless Google explicitly reports it closed right now or temporarily closed", () => {
    const places = toPlaces([
      raw("open-explicit", "Open Pharmacy", 6.69, ["pharmacy"], {
        currentOpeningHours: { openNow: true },
      }),
      raw("open-no-hours", "Sari-Sari Store", 6.69, ["convenience_store"]),
      raw("closed-current", "Closed Cafe", 6.69, ["cafe"], {
        currentOpeningHours: { openNow: false },
      }),
      raw("closed-regular", "Closed Bakery", 6.69, ["bakery"], {
        regularOpeningHours: { openNow: false },
      }),
      raw("closed-temp", "Renovating Diner", 6.69, ["restaurant"], {
        businessStatus: "CLOSED_TEMPORARILY",
        currentOpeningHours: { openNow: true },
      }),
    ]);
    expect(places.map((p) => [p.googlePlaceId, p.isOpen, p.openNow])).toEqual([
      ["open-explicit", true, true],
      ["open-no-hours", true, null],
      ["closed-current", false, false],
      ["closed-regular", false, false],
      ["closed-temp", false, false],
    ]);
  });

  it("evaluates 3-tier operating hours: malls use Google closing time, convenience stores & 24/7 fast food use 24/7 / Google time, and small stores use expected hours calibrated by historical orders", async () => {
    const near = { latitude: 6.69, longitude: 124.68 };
    // 10:30 PM Philippine Time (14:30 UTC)
    const lateNightPh = new Date("2026-10-12T14:30:00Z");
    // 2:00 PM Philippine Time (06:00 UTC)
    const afternoonPh = new Date("2026-10-12T06:00:00Z");

    google.nearby = toPlaces([
      // Mall with Google Maps closing time -> closed at 10:30 PM, opens at 8:00 AM
      raw("mall-kcc", "KCC Mall de Tacurong", 6.6901, ["shopping_mall"], {
        currentOpeningHours: { openNow: false, nextOpenTime: "2026-10-13T00:00:00Z" },
      }),
      // Convenience store in Tacurong -> 24/7 open even at 10:30 PM with no Google hours
      raw("conv-local", "Tacurong Mini Mart", 6.6902, ["convenience_store"]),
      // 24/7 Fast Food (McDonald's) with Google Maps openNow: true -> open at 10:30 PM
      raw("ff-mcdo", "McDonald's Tacurong", 6.6903, ["fast_food_restaurant"], {
        currentOpeningHours: { openNow: true },
      }),
      // Fast Food branch (Jollibee Center) with Google Maps openNow: false at 10:30 PM -> closed, opens at 6:00 AM
      raw("ff-jb-closed", "Jollibee Tacurong Center", 6.6904, ["fast_food_restaurant"], {
        currentOpeningHours: { openNow: false },
      }),
      // Small bakery with no historical late-night orders -> open at 2:00 PM, closed at 10:30 PM (Opens at 5:30 AM)
      raw("small-bakery", "Tericfic Special Buko Pie", 6.6905, ["bakery"]),
      // Small late-night eatery that has historical orders around 10:15 PM PH time -> stays open at 10:30 PM!
      raw("small-night-cafe", "Kusina Night Hub", 6.6906, ["restaurant"]),
      // Store under renovation -> Temporarily Unavailable
      raw("temp-closed", "Renovating Pharmacy", 6.6907, ["pharmacy"], {
        businessStatus: "CLOSED_TEMPORARILY",
      }),
    ]);

    // Historical order at "Kusina Night Hub" placed at 10:15 PM PH time (14:15 UTC) 3 days ago
    history.pins = [
      {
        errandId: "hist-night-1",
        storeName: "Kusina Night Hub",
        latitude: 6.6906,
        longitude: 124.68,
        placeId: null,
        errand: {
          customerId: 10,
          createdAt: new Date("2026-10-09T14:15:00Z"),
        },
      },
    ];

    const nightResult = await searchEstablishments({ near, limit: 10, now: lateNightPh });
    const nightStatus = Object.fromEntries(
      nightResult.items.map((item) => [item.name, { isOpen: item.isOpen, closedReason: item.closedReason }])
    );
    expect(nightStatus).toEqual({
      "KCC Mall de Tacurong": { isOpen: false, closedReason: "Opens at 8:00 AM" },
      "Tacurong Mini Mart": { isOpen: true, closedReason: null },
      "McDonald's Tacurong": { isOpen: true, closedReason: null },
      "Jollibee Tacurong Center": { isOpen: false, closedReason: "Opens at 6:00 AM" },
      "Tericfic Special Buko Pie": { isOpen: false, closedReason: "Opens at 5:30 AM" },
      "Kusina Night Hub": { isOpen: true, closedReason: null },
      "Renovating Pharmacy": { isOpen: false, closedReason: "Temporarily Unavailable" },
    });

    clearPopularPool();
    const afternoonResult = await searchEstablishments({ near, limit: 10, now: afternoonPh });
    const afternoonBakery = afternoonResult.items.find((item) => item.name === "Tericfic Special Buko Pie");
    expect(afternoonBakery?.isOpen).toBe(true);
    expect(afternoonBakery?.closedReason).toBeNull();
  });
});

describe("a Google shop's category", () => {
  it("comes from its type, matched to the categories this site really has", () => {
    expect(categoryForGoogleTypes(["pharmacy"], null, ACTIVE)?.name).toBe("Pharmacy");
    expect(categoryForGoogleTypes(["fast_food_restaurant", "restaurant"], null, ACTIVE)?.name).toBe("Fast Food");
    expect(categoryForGoogleTypes(["chinese_restaurant"], null, ACTIVE)?.name).toBe("Restaurant");
    expect(categoryForGoogleTypes(["convenience_store", "store"], null, ACTIVE)?.name).toBe("Convenience Store");
    expect(categoryForGoogleTypes(["hardware_store"], null, ACTIVE)?.name).toBe("Retail & General Merchandise");
  });

  it("files a cafe under Cafe where the site has that category, and under Restaurant where it does not", () => {
    const withCafe = [...ACTIVE, { id: 8, name: "Cafe" }];
    expect(categoryForGoogleTypes(["cafe", "restaurant"], "cafe", withCafe)?.name).toBe("Cafe");
    expect(categoryForGoogleTypes(["coffee_shop"], null, withCafe)?.name).toBe("Cafe");
    expect(categoryForGoogleTypes(["restaurant", "cafe"], "restaurant", withCafe)?.name).toBe("Restaurant");
    expect(categoryForGoogleTypes(["cafe"], null, ACTIVE)?.name).toBe("Restaurant");
  });

  describe("adapting to the owner's categories (2026-10-10)", () => {
    // Production's categories and descriptions as the owner wrote them.
    const PRODUCTION = [
      { id: 1, name: "Fast Food", description: "Commercial food designed for rapid preparation, efficient distribution, and quick service" },
      { id: 2, name: "Pharmacy", description: "Drugstores, medical supply stores, and clinics" },
      { id: 3, name: "Supermarket & Grocery", description: "Supermarkets, convenience stores, and public market stalls" },
      { id: 4, name: "Retail & General Merchandise", description: "Department stores, hardware, school supplies, and dry goods" },
      { id: 5, name: "Bakery", description: "Baked goods made primarily from flour and water" },
      {
        id: 6,
        name: "Convenience Store",
        description: "A small retail shop that sells everyday essentials like snacks, beverages, groceries, and household items",
      },
      { id: 7, name: "Restaurant", description: "Match the actual vibe of your dining room: casual and cozy, fast and fun, or refined and warm" },
      { id: 8, name: "Cafe", description: "A small, casual eating and drinking establishment that focuses primarily on coffee, tea, and light refreshments." },
    ];
    const of = (types: string[], categories = PRODUCTION) => categoryForGoogleTypes(types, null, categories)?.name ?? null;

    it("still sorts production's shops as before, and its Cafe gets the cafes", () => {
      expect(
        Object.fromEntries(
          [
            "bakery", "cafe", "coffee_shop", "tea_house", "restaurant", "chinese_restaurant", "fast_food_restaurant",
            "meal_takeaway", "pizza_restaurant", "pharmacy", "drugstore", "supermarket", "grocery_store", "market",
            "convenience_store", "liquor_store", "department_store", "hardware_store", "shopping_mall", "pet_store",
            "food_court", "food_store", "store",
          ].map((type) => [type, of([type])])
        )
      ).toEqual({
        bakery: "Bakery",
        cafe: "Cafe",
        coffee_shop: "Cafe",
        tea_house: "Cafe",
        restaurant: "Restaurant",
        chinese_restaurant: "Restaurant",
        fast_food_restaurant: "Fast Food",
        meal_takeaway: "Fast Food",
        pizza_restaurant: "Fast Food",
        pharmacy: "Pharmacy",
        drugstore: "Pharmacy",
        supermarket: "Supermarket & Grocery",
        grocery_store: "Supermarket & Grocery",
        market: "Supermarket & Grocery",
        convenience_store: "Convenience Store",
        liquor_store: "Convenience Store",
        department_store: "Retail & General Merchandise",
        hardware_store: "Retail & General Merchandise",
        shopping_mall: "Retail & General Merchandise",
        pet_store: "Retail & General Merchandise",
        food_court: "Restaurant",
        food_store: null,
        store: null,
      });
      // A bakery cafe is a bakery first, as Google lists it.
      expect(categoryForGoogleTypes(["cafe", "bakery"], "bakery", PRODUCTION)?.name).toBe("Bakery");
    });

    it("gives a category the owner adds the shops it is named after, with no code change", () => {
      const added = [
        ...PRODUCTION,
        { id: 9, name: "Pet Supplies", description: null },
        { id: 10, name: "Hardware", description: "Tools, paint and construction supplies" },
        { id: 11, name: "Milk Tea", description: "Milk tea and fruit shakes" },
        { id: 12, name: "Flowers & Gifts", description: "Florists and gift shops" },
      ];
      expect(of(["pet_store"], added)).toBe("Pet Supplies");
      expect(of(["hardware_store"], added)).toBe("Hardware");
      // Its name beats Cafe's description.
      expect(of(["tea_house"], added)).toBe("Milk Tea");
      expect(of(["florist"], added)).toBe("Flowers & Gifts");
      expect(of(["gift_shop"], added)).toBe("Flowers & Gifts");
      // The rest are untouched.
      expect(of(["department_store"], added)).toBe("Retail & General Merchandise");
      expect(of(["cafe"], added)).toBe("Cafe");
    });

    it("reads a description, plurals and accents, and puts a name above a description", () => {
      const cats = [
        { id: 1, name: "Restaurant", description: null },
        { id: 2, name: "Cafés", description: null },
        { id: 3, name: "Sweets", description: "Ice cream shops, donut shops and desserts" },
      ];
      expect(of(["coffee_shop"], cats)).toBe("Cafés");
      expect(of(["ice_cream_shop"], cats)).toBe("Sweets");
      expect(of(["donut_shop"], cats)).toBe("Sweets");
      // Two names claiming alike go to the shorter; a true tie to the built-in kinds.
      expect(of(["grocery_store"], [{ id: 1, name: "Grocery" }, { id: 2, name: "Supermarket & Grocery" }])).toBe("Grocery");
      expect(of(["pharmacy"], [{ id: 1, name: "Pharmacy A" }, { id: 2, name: "Pharmacy B" }])).toBe("Pharmacy A");
    });

    it("lets no category claim a type that names no kind of shop", () => {
      const cats = [...PRODUCTION, { id: 9, name: "School Supplies", description: "Notebooks for school" }];
      expect(of(["school"], cats)).toBeNull();
      expect(of(["establishment", "point_of_interest"], cats)).toBeNull();
    });
  });

  it("files a bakery as a bakery, not as the food it also sells", () => {
    expect(categoryForGoogleTypes(["food", "bakery", "restaurant"], null, ACTIVE)?.name).toBe("Bread & Pastry");
  });

  it("falls to the nearest kind a site has, and to nothing over a guess", () => {
    const seedNames = [
      { id: 10, name: "Fast Food & Restaurant" },
      { id: 11, name: "Supermarket & Grocery" },
    ];
    expect(categoryForGoogleTypes(["bakery"], null, seedNames)?.name).toBe("Fast Food & Restaurant");
    expect(categoryForGoogleTypes(["convenience_store"], null, seedNames)?.name).toBe("Supermarket & Grocery");
    expect(categoryForGoogleTypes(["store", "establishment"], null, ACTIVE)).toBeNull();
  });

  it("asks the model only about a shop Google filed as a plain store", async () => {
    model.answer = { id: 6, name: "Convenience Store" };
    const places = toPlaces([raw("a", "Mercury Drug", 6.69, ["pharmacy"]), raw("b", "Aling Nena", 6.69, ["store"])]);
    const answers = await categorizeGooglePlaces(places, ACTIVE);
    expect(answers.map((a) => a?.name)).toEqual(["Pharmacy", "Convenience Store"]);
  });

  it("never holds the list up for a slow model", async () => {
    model.answer = { id: 6, name: "Convenience Store" };
    model.delayMs = 200;
    const places = toPlaces([raw("b", "Aling Nena", 6.69, ["store"])]);
    expect(await categorizeGooglePlaces(places, ACTIVE, 20)).toEqual([null]);
  });
});

describe("one list from both sources", () => {
  const near = { latitude: 6.69, longitude: 124.68 };
  const cat = (id: string, name: string, lat: number) => fromCatalogue(place(id, name, lat), near);
  const ggl = (id: string, name: string, lat: number) =>
    fromGoogle(toPlaces([raw(id, name, lat, ["pharmacy"])])[0], { id: 3, name: "Pharmacy" }, near);

  it("lists a shop found by both only once, as the owner's verified row while inheriting Google's photo and rating", () => {
    const googleWithPhoto = {
      ...ggl("g1", "Mercury Drug Tacurong", 6.6901),
      photoName: "places/g1/photos/storefront",
      photoAttribution: "Mercury Official",
      rating: 4.8,
      ratingCount: 215,
    };
    const merged = mergeEstablishments([cat("p1", "Mercury Drug", 6.69)], [googleWithPhoto]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      source: "catalogue",
      placeId: "p1",
      photoName: "places/g1/photos/storefront",
      photoAttribution: "Mercury Official",
      rating: 4.8,
      ratingCount: 215,
    });
  });

  it("keeps two branches of one chain apart", () => {
    const merged = mergeEstablishments([cat("p1", "Mercury Drug", 6.69)], [ggl("g1", "Mercury Drug", 6.7)]);
    expect(merged).toHaveLength(2);
  });

  it("never lists more than the limit, and never the same row twice", () => {
    const many = (prefix: string, maker: (id: string, name: string, lat: number) => Establishment) =>
      Array.from({ length: 8 }, (_, i) => maker(`${prefix}${i}`, `${prefix} shop ${i}`, 6.65 + i * 0.01));
    const merged = mergeEstablishments(many("c", cat), many("g", ggl), 10);
    expect(merged).toHaveLength(10);
    expect(new Set(merged.map((e) => e.key)).size).toBe(10);
    expect(merged.some((e) => e.source === "catalogue")).toBe(true);
    expect(merged.some((e) => e.source === "google")).toBe(true);
  });
});

describe("the search", () => {
  it("lists the shops nearest the customer from Google when nothing is typed", async () => {
    google.nearby = toPlaces([raw("g1", "Mercury Drug", 6.69, ["pharmacy"])]);
    const result = await searchEstablishments({ near: { latitude: 6.69, longitude: 124.68 } });
    expect(result.google).toBe("ok");
    expect(result.items[0]).toMatchObject({ name: "Mercury Drug", categoryName: "Pharmacy", source: "google", distanceMeters: 0 });
  });

  it("falls back to the owner's stores, nearest first, when Google cannot answer", async () => {
    catalogue.rows = [place("far", "Far Pharmacy", 6.75), place("near", "Near Pharmacy", 6.691)];
    const result = await searchEstablishments({ near: { latitude: 6.69, longitude: 124.68 } });
    expect(result.google).toBe("unavailable");
    expect(result.items.map((e) => e.name)).toEqual(["Near Pharmacy", "Far Pharmacy"]);
  });

  it("searches both sources for a typed name", async () => {
    catalogue.rows = [place("p1", "Rose Pharmacy", 6.69)];
    google.text = toPlaces([raw("g1", "Mercury Drug", 6.7, ["pharmacy"])]);
    const result = await searchEstablishments({ query: "drug" });
    expect(result.items.map((e) => e.source).sort()).toEqual(["catalogue", "google"]);
    expect(result.items.every((e) => e.distanceMeters === null)).toBe(true);
  });

  it("returns empty items and outsideServiceArea: true when the customer's point is outside Tacurong", async () => {
    google.nearby = [];
    const { searchNearbyPlaces, searchPopularPlaces } = await import("../src/lib/places/googlePlacesClient.js");
    vi.mocked(searchNearbyPlaces).mockClear();
    vi.mocked(searchPopularPlaces).mockClear();

    const searchResult = await searchEstablishments({ near: { latitude: 7.5, longitude: 124.68 } });
    expect(searchResult).toEqual({
      items: [],
      google: "ok",
      outsideServiceArea: true,
      hasMore: false,
    });
    expect(searchNearbyPlaces).not.toHaveBeenCalled();

    const popularResult = await popularEstablishments({ near: { latitude: 7.5, longitude: 124.68 } });
    expect(popularResult).toEqual({
      items: [],
      google: "ok",
      total: 0,
      hasMore: false,
      outsideServiceArea: true,
    });
    expect(searchPopularPlaces).not.toHaveBeenCalled();
  });

  const shops = (n: number) =>
    Array.from({ length: n }, (_, i) => raw(`g${i}`, `Shop ${i}`, 6.69 + i * 0.001, ["pharmacy"]));

  it("lists only the four nearest before anything is typed, in Google's order", async () => {
    google.nearby = toPlaces(shops(10));
    const result = await searchEstablishments({ near: { latitude: 6.69, longitude: 124.68 } });
    expect(result.items.map((e) => e.name)).toEqual(["Shop 0", "Shop 1", "Shop 2", "Shop 3"]);
  });

  it("keeps the owner's-stores fallback to four as well", async () => {
    catalogue.rows = Array.from({ length: 6 }, (_, i) => place(`p${i}`, `Pharmacy ${i}`, 6.69 + i * 0.001));
    const result = await searchEstablishments({ near: { latitude: 6.69, longitude: 124.68 } });
    expect(result.google).toBe("unavailable");
    expect(result.items).toHaveLength(4);
  });

  // "Find stores" (2026-10-14): the featured brands first, one branch each,
  // then everything else in the usual order. Home's row is untouched.
  describe("with the featured brands first", () => {
    const near = { latitude: 6.69, longitude: 124.68 };
    const withBrands = () =>
      toPlaces([
        ...shops(6),
        raw("s1", "Savemore Market Tacurong", 6.703, ["supermarket"]),
        raw("e1", "7-Eleven Tacurong New Isabela (3453)", 6.7, ["convenience_store"]),
        raw("e2", "7-Eleven Poblacion", 6.706, ["convenience_store"]),
      ]);

    it("lists the nearest branch of each featured brand first, marked, then the rest", async () => {
      google.nearby = withBrands();
      const result = await searchEstablishments({ near, featured: true, limit: 10 });
      const names = result.items.map((e) => e.name);

      expect(names.slice(0, 2)).toEqual(["7-Eleven Tacurong New Isabela (3453)", "Savemore Market Tacurong"]);
      expect(result.items.slice(0, 2).every((e) => e.featured === true)).toBe(true);
      // The second 7-Eleven is not recommended twice: it keeps its usual place.
      const second = result.items.find((e) => e.name === "7-Eleven Poblacion");
      expect(second?.featured).toBe(false);
      expect(names.indexOf("7-Eleven Poblacion")).toBeGreaterThan(names.indexOf("Shop 5"));
      expect(result.items.filter((e) => !e.featured).every((e) => e.featured === false)).toBe(true);
    });

    it("pages the same order, so See more continues where the first page ended", async () => {
      google.nearby = withBrands();
      const first = await searchEstablishments({ near, featured: true, offset: 0, limit: 5 });
      const next = await searchEstablishments({ near, featured: true, offset: 5, limit: 5 });
      expect(first.hasMore).toBe(true);
      const all = [...first.items, ...next.items].map((e) => e.key);
      expect(new Set(all).size).toBe(all.length);
      expect(all).toHaveLength(9);
      expect(next.hasMore).toBe(false);
    });

    it("leaves Home's row in the plain order, with no featured flags", async () => {
      google.nearby = withBrands();
      const result = await searchEstablishments({ near, limit: 10 });
      expect(result.items[0].name).toBe("Shop 0");
      expect(result.items.some((e) => "featured" in e)).toBe(false);
    });
  });

  it("still lists up to ten for a typed name", async () => {
    google.text = toPlaces(shops(12));
    const result = await searchEstablishments({ query: "shop" });
    expect(result.items).toHaveLength(10);
  });
});

describe("a shop's address", () => {
  it("drops the Plus Code Google puts in front of it", () => {
    expect(withoutPlusCode("MMJ7+HC9, Tacurong City, Sultan Kudarat")).toBe("Tacurong City, Sultan Kudarat");
    expect(withoutPlusCode("MMJ7+HC9 Tacurong City")).toBe("Tacurong City");
    expect(withoutPlusCode("6QMRMMJ7+HC, Tacurong")).toBe("Tacurong");
    // A Plus Code and nothing else leaves no address, which the app hides.
    expect(withoutPlusCode("MMJ7+HC9")).toBe("");
  });

  it("leaves a real address alone", () => {
    expect(withoutPlusCode("Mabini St, Poblacion")).toBe("Mabini St, Poblacion");
    expect(withoutPlusCode("22+ Mart, Alunan Ave")).toBe("22+ Mart, Alunan Ave");
  });

  it("reaches the customer's list from Google", async () => {
    google.nearby = toPlaces([raw("g1", "Mercury Drug", 6.69, ["pharmacy"], { shortFormattedAddress: "MMJ7+HC9, Tacurong City" })]);
    const result = await searchEstablishments({ near: { latitude: 6.69, longitude: 124.68 } });
    expect(result.items[0].address).toBe("Tacurong City");
  });
});

describe("past orders", () => {
  const near = { latitude: 6.69, longitude: 124.68 };
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
  const pin = (over: Partial<PastOrderPin>): PastOrderPin => ({
    errandId: "e1",
    customerId: 5,
    orderedAt: daysAgo(10),
    storeName: "Mercury Drug",
    latitude: 6.69,
    longitude: 124.68,
    placeId: null,
    ...over,
  });
  // The shape prisma.errandPinpoint.findMany returns.
  const dbPin = (p: PastOrderPin) => ({
    errandId: p.errandId,
    storeName: p.storeName,
    latitude: p.latitude,
    longitude: p.longitude,
    placeId: p.placeId,
    errand: { customerId: p.customerId, createdAt: p.orderedAt },
  });

  it("finds a store again by name and place, and keeps the customer's habit apart from everyone's", () => {
    const mercury = fromGoogle(toPlaces([raw("g1", "Mercury Drug", 6.69, ["pharmacy"])])[0], null, near);
    const rose = fromCatalogue(place("p1", "Rose Pharmacy", 6.7), near);
    const pins = [
      pin({ errandId: "e1" }),
      pin({ errandId: "e1", latitude: 6.69001 }), // a second stop of one errand counts once
      pin({ errandId: "e2", customerId: 9, storeName: "Mercury Drug Tacurong", latitude: 6.6901, orderedAt: daysAgo(5) }),
      pin({ errandId: "e3", customerId: 9, orderedAt: daysAgo(200) }), // too old to make it popular
      pin({ errandId: "e4", customerId: 9, storeName: "Rose Pharmacy Main", latitude: 6.7, placeId: "p1" }),
      pin({ errandId: "e5", customerId: 9, latitude: 6.6945 }), // another branch, 500 m away
    ];

    const forCustomer = tallyStoreHistory([mercury, rose], pins, 5);
    expect(forCustomer.get(mercury.key)).toMatchObject({ orderedBefore: true });
    expect(forCustomer.get(mercury.key)!.personal).toBeCloseTo(Math.pow(0.5, 10 / 60), 2);
    expect(forCustomer.get(mercury.key)!.popular).toBeCloseTo(Math.pow(0.5, 5 / 30), 2);
    expect(forCustomer.get(rose.key)).toMatchObject({ personal: 0, orderedBefore: false });
    expect(forCustomer.get(rose.key)!.popular).toBeGreaterThan(0);

    // A staff search has no habits of its own; every order is everyone's.
    const forStaff = tallyStoreHistory([mercury, rose], pins, null);
    expect(forStaff.get(mercury.key)).toMatchObject({ personal: 0, orderedBefore: false });
    expect(forStaff.get(mercury.key)!.popular).toBeGreaterThan(forCustomer.get(mercury.key)!.popular);
  });

  const twoBranches = () =>
    toPlaces([raw("g1", "Mercury Drug", 6.692, ["pharmacy"]), raw("g2", "Mercury Drug", 6.6932, ["pharmacy"])]);
  const usualAtG2 = () =>
    ["e1", "e2", "e3"].map((errandId) => dbPin(pin({ errandId, latitude: 6.6932, orderedAt: daysAgo(3) })));

  it("puts the branch a customer keeps using first, and says they ordered there", async () => {
    google.nearby = twoBranches();
    history.pins = usualAtG2();
    const result = await searchEstablishments({ near, customerId: 5 });
    expect(result.items.map((e) => [e.googlePlaceId, e.orderedBefore])).toEqual([
      ["g2", true],
      ["g1", false],
    ]);
  });

  it("never tells a dispatcher they ordered from a store", async () => {
    google.nearby = twoBranches();
    history.pins = usualAtG2();
    const result = await searchEstablishments({ near, customerId: null });
    expect(result.items.every((e) => e.orderedBefore === false)).toBe(true);
  });

  it("ranks on distance alone when order history cannot be read", async () => {
    google.nearby = twoBranches();
    history.fail = true;
    const result = await searchEstablishments({ near, customerId: 5 });
    expect(result.items.map((e) => e.googlePlaceId)).toEqual(["g1", "g2"]);
  });

  it("lists a chain's branches closest first for a typed search, after every store named like it", async () => {
    google.text = toPlaces([
      raw("far", "Mercury Drug", 6.71, ["pharmacy"]),
      raw("corner", "Corner Store", 6.6901, ["store"]),
      raw("near", "Mercury Drug", 6.692, ["pharmacy"]),
      raw("mid", "Mercury Drug", 6.7, ["pharmacy"]),
      raw("close", "Mercury Drug", 6.6935, ["pharmacy"]),
    ]);
    const result = await searchEstablishments({ query: "mercury", near, customerId: 5 });
    expect(result.items.map((e) => e.googlePlaceId)).toEqual(["near", "close", "mid", "far", "corner"]);
  });

  it("works out a category only for the rows shown", async () => {
    const { inferStoreCategory } = await import("../src/services/categoryInferenceService.js");
    vi.mocked(inferStoreCategory).mockClear();
    model.answer = { id: 6, name: "Convenience Store" };
    google.nearby = toPlaces(Array.from({ length: 12 }, (_, i) => raw(`s${i}`, `Sari-sari ${i}`, 6.69 + i * 0.001, ["store"])));
    const result = await searchEstablishments({ near });
    expect(result.items).toHaveLength(4);
    expect(result.items.every((e) => e.categoryName === "Convenience Store")).toBe(true);
    expect(inferStoreCategory).toHaveBeenCalledTimes(4);
  });
});

describe("photos for the Home row", () => {
  const near = { latitude: 6.69, longitude: 124.68 };
  const shops = () =>
    toPlaces([
      raw("g1", "Mercury Drug", 6.692, ["pharmacy"], { photos: [{ name: "places/g1/photos/p1" }] }),
      raw("g2", "Aling Nena", 6.693, ["pharmacy"]),
    ]);

  it("carry each shop's image address when asked for, and none for a shop without a photo", async () => {
    google.nearby = shops();
    const result = await searchEstablishments({ near, withPhotos: true });
    expect(result.items.map((e) => e.photoUrl)).toEqual(["https://lh3.googleusercontent.com/places/g1/photos/p1", null]);
  });

  it("are not looked up for a list that does not show them", async () => {
    const { resolvePhotoUris } = await import("../src/lib/places/placePhotos.js");
    vi.mocked(resolvePhotoUris).mockClear();
    google.nearby = shops();
    const result = await searchEstablishments({ near });
    expect(result.items.every((e) => e.photoUrl === null)).toBe(true);
    expect(resolvePhotoUris).not.toHaveBeenCalled();
  });
});

describe("popular stores", () => {
  const near = { latitude: 6.69, longitude: 124.68 };
  const shop = (id: string, name: string, type: string, rating: number | null, count: number | null, extra: object = {}) =>
    raw(id, name, 6.69 + Number(id.replace(/\D/g, "") || 0) * 0.001, [type], { rating, userRatingCount: count, ...extra });
  const FOOD = JSON.stringify(["bakery", "fast_food_restaurant", "meal_takeaway", "restaurant", "cafe"]);
  const SHOPS = JSON.stringify(["pharmacy", "drugstore", "supermarket", "grocery_store", "convenience_store", "department_store", "hardware_store", "shopping_mall"]);
  // Google's answer per group of types, keyed the way the searches ask.
  const answers = (byTypes: Record<string, unknown[]>) => {
    google.popular = (types: string[]) => toPlaces(byTypes[JSON.stringify(types)] ?? []);
  };

  it("reads Google's rating and how many rated it", () => {
    const [found] = toPlaces([shop("a1", "Mercury Drug", "pharmacy", 4.6, 210)]);
    expect(found).toMatchObject({ rating: 4.6, ratingCount: 210 });
    // A search that did not ask for ratings carries none.
    expect(toPlaces([raw("b", "Rose Pharmacy", 6.69)])[0]).toMatchObject({ rating: null, ratingCount: null });
  });

  it("shows the best rated shop of each merchant category, the winners best rated first", async () => {
    answers({
      [FOOD]: [
        shop("f1", "Decent Cup", "cafe", 4.8, 50),
        shop("f2", "Nanay's Cafe", "cafe", 4.6, 200),
        shop("f3", "Jollibee", "fast_food_restaurant", 4.2, 80),
        shop("f4", "Julie's Bakeshop", "bakery", 4.5, 30),
      ],
      [SHOPS]: [
        shop("s1", "Mercury Drug", "pharmacy", 4.3, 40),
        shop("s2", "New Pharmacy", "pharmacy", 4.9, 3),
        shop("s3", "Savemore", "supermarket", 4.0, 90),
        shop("s4", "7-Eleven", "convenience_store", 3.9, 12),
        shop("s5", "Citimart", "department_store", 4.4, 25),
      ],
    });
    const result = await popularEstablishments({ near, customerId: 5 });
    // One per category: Nanay's Cafe loses to Decent Cup, and New Pharmacy's
    // three ratings lose to Mercury Drug's forty. Six of seven winners shown.
    expect(result.items.map((e) => [e.name, e.categoryName])).toEqual([
      ["Decent Cup", "Restaurant"],
      ["Julie's Bakeshop", "Bread & Pastry"],
      ["Citimart", "Retail & General Merchandise"],
      ["Mercury Drug", "Pharmacy"],
      ["Jollibee", "Fast Food"],
      ["Savemore", "Supermarket & Grocery"],
    ]);
    expect(result.items[0]).toMatchObject({ rating: 4.8, ratingCount: 50 });
    expect(result.items[0].distanceMeters).toBeGreaterThan(0);
  });

  it("asks twice when the two searches cover every category, and once more per category they missed", async () => {
    const { searchPopularPlaces } = await import("../src/lib/places/googlePlacesClient.js");
    const covered = {
      [FOOD]: [
        shop("f1", "Decent Cup", "cafe", 4.8, 50),
        shop("f3", "Jollibee", "fast_food_restaurant", 4.2, 80),
        shop("f4", "Julie's Bakeshop", "bakery", 4.5, 30),
      ],
      [SHOPS]: [
        shop("s1", "Mercury Drug", "pharmacy", 4.3, 40),
        shop("s3", "Savemore", "supermarket", 4.0, 90),
        shop("s4", "7-Eleven", "convenience_store", 3.9, 12),
        shop("s5", "Citimart", "department_store", 4.4, 25),
      ],
    };
    answers(covered);
    vi.mocked(searchPopularPlaces).mockClear();
    await popularEstablishments({ near });
    expect(searchPopularPlaces).toHaveBeenCalledTimes(2);

    // No bakery among the food, and the only convenience store unrated.
    answers({
      [FOOD]: covered[FOOD].filter((p: any) => p.id !== "f4"),
      [SHOPS]: [...covered[SHOPS].filter((p: any) => p.id !== "s4"), shop("s6", "Unrated Sari-sari", "convenience_store", null, null)],
      [JSON.stringify(["bakery"])]: [shop("b1", "Tacurong Bakery", "bakery", 4.7, 18)],
      // Every searchable type that files under the category: liquor stores are convenience stores here.
      [JSON.stringify(["convenience_store", "liquor_store"])]: [shop("c1", "Alfamart", "convenience_store", 4.1, 22)],
    });
    clearPopularPool(); // the first answer is still kept for this spot
    vi.mocked(searchPopularPlaces).mockClear();
    const result = await popularEstablishments({ near });
    expect(vi.mocked(searchPopularPlaces).mock.calls.map((call) => call[1])).toEqual([
      expect.arrayContaining(["cafe"]),
      expect.arrayContaining(["pharmacy"]),
      ["bakery"],
      ["convenience_store", "liquor_store"],
    ]);
    expect(result.items.map((e) => e.name)).toContain("Alfamart");
    expect(result.items.map((e) => e.name)).toContain("Tacurong Bakery");
    expect(result.items.map((e) => e.name)).not.toContain("Unrated Sari-sari");
  });

  it("still lists Google's most popular shops, one per category first, when no rating could be paid for", async () => {
    // The Enterprise tier's free allowance used up (placesBudget.ts): no ratings anywhere.
    answers({
      [FOOD]: [shop("f1", "Jollibee", "fast_food_restaurant", null, null), shop("f2", "Chowking", "fast_food_restaurant", null, null)],
      [SHOPS]: [shop("s1", "Mercury Drug", "pharmacy", null, null)],
    });
    const result = await popularEstablishments({ near });
    expect(result.items.map((e) => e.name)).toEqual(["Jollibee", "Mercury Drug", "Chowking"]);
  });

  it("carries photo addresses when asked for, like the nearby row", async () => {
    answers({ [SHOPS]: [shop("s1", "Mercury Drug", "pharmacy", 4.5, 40, { photos: [{ name: "places/s1/photos/p1" }] })] });
    const result = await popularEstablishments({ near, withPhotos: true });
    expect(result.items[0].photoUrl).toBe("https://lh3.googleusercontent.com/places/s1/photos/p1");
  });

  it("says Google is unavailable rather than calling unrated stores popular", async () => {
    catalogue.rows = [place("p1", "Rose Pharmacy", 6.69)];
    google.popular = null;
    const result = await popularEstablishments({ near });
    expect(result).toEqual({ items: [], google: "unavailable", total: 0, hasMore: false });
  });

  describe("on the Popular Stores screen (2026-10-10)", () => {
    // 3 categories' winners plus 22 more rated shops: more than the screen's 20.
    const many = () => ({
      [FOOD]: [
        shop("f1", "Decent Cup", "cafe", 4.8, 50),
        ...Array.from({ length: 22 }, (_, i) => shop(`f${10 + i}`, `Cafe ${i}`, "cafe", 4.0 + (i % 5) / 10, 10 + i)),
      ],
      [SHOPS]: [shop("s1", "Mercury Drug", "pharmacy", 4.3, 40), shop("s3", "Savemore", "supermarket", 4.0, 900)],
    });

    it("pages through at most 20, the category winners first, then the rest best rated", async () => {
      answers(many());
      const first = await popularEstablishments({ near });
      expect(first.items.map((e) => e.name).slice(0, 3)).toEqual(["Decent Cup", "Mercury Drug", "Savemore"]);
      expect(first.items).toHaveLength(6);
      expect(first).toMatchObject({ total: 20, hasMore: true });

      const pages = [first];
      for (let offset = 6; offset < 20; offset += 6) pages.push(await popularEstablishments({ near, offset, limit: 6 }));
      const names = pages.flatMap((page) => page.items.map((e) => e.name));
      expect(names).toHaveLength(20);
      expect(new Set(names).size).toBe(20);
      expect(pages[pages.length - 1].hasMore).toBe(false);
      // After the winners, best rated first.
      const rest = pages.flatMap((page) => page.items).slice(3);
      expect(rest.map((e) => e.rating)).toEqual([...rest.map((e) => e.rating)].sort((a, b) => b! - a!));
    });

    it("searches once for every page and sort, while the answer is fresh", async () => {
      const { searchPopularPlaces } = await import("../src/lib/places/googlePlacesClient.js");
      answers(many());
      vi.mocked(searchPopularPlaces).mockClear();
      await popularEstablishments({ near });
      const searches = vi.mocked(searchPopularPlaces).mock.calls.length;
      await popularEstablishments({ near, offset: 6 });
      await popularEstablishments({ near, sort: "distance" });
      expect(vi.mocked(searchPopularPlaces).mock.calls.length).toBe(searches);
    });

    it("sorts the same set by distance or by reviews", async () => {
      answers(many());
      const byDistance = await popularEstablishments({ near, sort: "distance", limit: 20 });
      const metres = byDistance.items.map((e) => e.distanceMeters!);
      expect(metres).toEqual([...metres].sort((a, b) => a - b));

      const byReviews = await popularEstablishments({ near, sort: "reviews", limit: 20 });
      expect(byReviews.items[0].name).toBe("Savemore");
      expect(byReviews.items.map((e) => e.name).sort()).toEqual(byDistance.items.map((e) => e.name).sort());
    });

    it("answers past the end with nothing more", async () => {
      answers(many());
      expect(await popularEstablishments({ near, offset: 40 })).toMatchObject({ items: [], total: 20, hasMore: false });
    });

    it("filters popular stores to a specific merchant category (up to 10 by default) and caches by category", async () => {
      const { searchPopularPlaces } = await import("../src/lib/places/googlePlacesClient.js");
      answers({
        [JSON.stringify(["pharmacy", "drugstore"])]: [
          shop("p1", "Mercury Drug", "pharmacy", 4.9, 120),
          shop("p2", "Rose Pharmacy", "drugstore", 4.6, 80),
          shop("p3", "Unrated Pharmacy", "pharmacy", null, null),
          // Supermarket accidentally returned in the same search should be excluded
          shop("s1", "Savemore", "supermarket", 4.8, 300),
        ],
      });
      vi.mocked(searchPopularPlaces).mockClear();

      const result = await popularEstablishments({ near, categoryId: 3 });
      expect(searchPopularPlaces).toHaveBeenCalledTimes(1);
      expect(searchPopularPlaces).toHaveBeenCalledWith(near, ["pharmacy", "drugstore"]);
      expect(result.google).toBe("ok");
      expect(result.items.map((e) => [e.name, e.categoryName, e.rating])).toEqual([
        ["Mercury Drug", "Pharmacy", 4.9],
        ["Rose Pharmacy", "Pharmacy", 4.6],
      ]);

      // Second call uses category-scoped cache
      await popularEstablishments({ near, categoryId: 3 });
      expect(searchPopularPlaces).toHaveBeenCalledTimes(1);

      // Inactive / unknown category returns empty list cleanly
      const unknown = await popularEstablishments({ near, categoryId: 999 });
      expect(unknown).toEqual({ items: [], google: "ok", total: 0, hasMore: false });
    });

    it("supports compound categories (e.g. Fast Food & Restaurant) and custom owner categories in popularEstablishments", async () => {
      const { searchPopularPlaces, searchPlacesByText } = await import("../src/lib/places/googlePlacesClient.js");
      const { merchantCategoryRepository } = await import("../src/repositories/merchantCategoryRepository.js");
      const withCompoundAndCustom = [
        ...ACTIVE,
        { id: 9, name: "Fast Food & Restaurant", description: "Restaurants, diners, fast-food chains, and carinderias." },
        { id: 10, name: "Water Refilling", description: "Purified and alkaline drinking water stations." },
      ];
      vi.mocked(merchantCategoryRepository.findMany).mockResolvedValue(withCompoundAndCustom as any);

      const compoundTypes = [
        "restaurant",
        "fast_food_restaurant",
        "meal_takeaway",
        "cafe",
        "coffee_shop",
        "sandwich_shop",
        "pizza_restaurant",
        "hamburger_restaurant",
      ];
      answers({
        [JSON.stringify(compoundTypes)]: [
          shop("r1", "Chiccoi's Diner", "restaurant", 4.7, 95),
          shop("ff1", "Jollibee Tacurong", "fast_food_restaurant", 4.5, 210),
          shop("p1", "Mercury Drug", "pharmacy", 4.8, 120),
        ],
      });
      vi.mocked(searchPopularPlaces).mockClear();

      const compoundResult = await popularEstablishments({ near, categoryId: 9 });
      expect(searchPopularPlaces).toHaveBeenCalledTimes(1);
      expect(compoundResult.items.map((e) => [e.name, e.categoryId, e.categoryName])).toEqual([
        ["Chiccoi's Diner", 9, "Fast Food & Restaurant"],
        ["Jollibee Tacurong", 9, "Fast Food & Restaurant"],
      ]);

      // Custom category with no Google type mapping uses searchPlacesByText with includeRatings: true
      google.text = toPlaces([
        shop("w1", "Aquabest Water Station", "store", 4.6, 25),
        shop("w2", "Crystal Water Refilling Mart", "grocery_store", 4.4, 15),
        shop("p2", "Rose Pharmacy", "pharmacy", 4.9, 90),
      ]);
      vi.mocked(searchPlacesByText).mockClear();

      const customResult = await popularEstablishments({ near, categoryId: 10 });
      expect(searchPlacesByText).toHaveBeenCalledWith("Water Refilling", { includeRatings: true });
      expect(customResult.items.map((e) => [e.name, e.categoryId, e.categoryName])).toEqual([
        ["Aquabest Water Station", 10, "Water Refilling"],
        ["Crystal Water Refilling Mart", 10, "Water Refilling"],
      ]);

      // Falls back to searchPlacesByText with includeRatings: true when searchPopularPlaces is refused (returns null)
      google.popular = null;
      google.text = toPlaces([
        shop("p3", "Watsons Pharmacy", "pharmacy", 4.7, 65),
        shop("s2", "Savemore", "supermarket", 4.5, 120),
      ]);
      clearPopularPool();
      vi.mocked(searchPlacesByText).mockClear();

      const fallbackResult = await popularEstablishments({ near, categoryId: 3 });
      expect(searchPlacesByText).toHaveBeenCalledWith("Pharmacy", { includeRatings: true });
      expect(fallbackResult.items.map((e) => [e.name, e.categoryId, e.categoryName])).toEqual([
        ["Watsons Pharmacy", 3, "Pharmacy"],
      ]);

      vi.mocked(merchantCategoryRepository.findMany).mockResolvedValue(ACTIVE as any);
    });
  });
});

describe("a merchant category's stores (2026-10-10)", () => {
  const near = { latitude: 6.69, longitude: 124.68 };
  const client = () => import("../src/lib/places/googlePlacesClient.js");

  it("asks Google for the category's kinds of shop across the city, and keeps only that category's", async () => {
    const { searchNearbyPlaces } = await client();
    google.nearby = toPlaces([
      raw("g1", "Mercury Drug", 6.692, ["pharmacy"]),
      raw("g2", "Rose Pharmacy", 6.691, ["drugstore", "pharmacy"]),
      // Google lists it for "pharmacy" too, but it is a supermarket first.
      raw("g3", "Savemore", 6.6905, ["supermarket", "pharmacy"]),
    ]);
    vi.mocked(searchNearbyPlaces).mockClear();
    const result = await searchEstablishments({ near, categoryId: 3 });

    expect(vi.mocked(searchNearbyPlaces).mock.calls[0].slice(1)).toEqual([["pharmacy", "drugstore"], 5000]);
    expect(result.google).toBe("ok");
    // Nearest first, each filed under the category it was listed for.
    expect(result.items.map((e) => [e.name, e.categoryName])).toEqual([
      ["Rose Pharmacy", "Pharmacy"],
      ["Mercury Drug", "Pharmacy"],
    ]);
  });

  it("lists up to 20, not the nearby four", async () => {
    google.nearby = toPlaces(
      Array.from({ length: 25 }, (_, i) => raw(`g${i}`, `Pharmacy ${i}`, 6.69 + i * 0.0005, ["pharmacy"]))
    );
    const result = await searchEstablishments({ near, categoryId: 3 });
    expect(result.items).toHaveLength(20);
    expect(result.items[0].name).toBe("Pharmacy 0");
  });

  it("merges in the owner's Location Stores of that category", async () => {
    const { placeService } = await import("../src/services/placeService.js");
    catalogue.rows = [place("p1", "Generika Alunan", 6.6902)];
    google.nearby = toPlaces([raw("g1", "Mercury Drug", 6.692, ["pharmacy"])]);
    vi.mocked(placeService.searchPlaces).mockClear();
    const result = await searchEstablishments({ near, categoryId: 3 });

    expect(placeService.searchPlaces).toHaveBeenCalledWith({ categoryId: 3 });
    expect(result.items.map((e) => [e.name, e.source])).toEqual([
      ["Generika Alunan", "catalogue"],
      ["Mercury Drug", "google"],
    ]);
  });

  it("searches by name inside the category, leaving out other kinds of shop", async () => {
    const { searchPlacesByText } = await client();
    google.text = toPlaces([
      raw("t1", "Mercury Drug", 6.69, ["pharmacy"]),
      raw("t2", "Mercury Supermarket", 6.691, ["supermarket"]),
    ]);
    vi.mocked(searchPlacesByText).mockClear();
    const result = await searchEstablishments({ query: "mercury", near, categoryId: 3 });

    expect(searchPlacesByText).toHaveBeenCalledWith("mercury");
    expect(result.items.map((e) => e.name)).toEqual(["Mercury Drug"]);
  });

  it("finds a category the owner just added by the shop types it is named after", async () => {
    const { searchNearbyPlaces } = await client();
    const { merchantCategoryRepository } = await import("../src/repositories/merchantCategoryRepository.js");
    vi.mocked(merchantCategoryRepository.findMany).mockResolvedValueOnce([...ACTIVE, { id: 8, name: "Pet Supplies" }] as any);
    google.nearby = toPlaces([
      raw("t1", "Paws Pet Shop", 6.691, ["pet_store", "store"]),
      raw("t2", "Citimart", 6.692, ["department_store"]),
    ]);
    vi.mocked(searchNearbyPlaces).mockClear();
    const result = await searchEstablishments({ near, categoryId: 8 });

    expect(vi.mocked(searchNearbyPlaces).mock.calls[0][1]).toEqual(["pet_store"]);
    expect(result.items.map((e) => [e.name, e.categoryName])).toEqual([["Paws Pet Shop", "Pet Supplies"]]);
  });

  it("searches a category no shop type names by its name, keeping shops no other category claims", async () => {
    const { searchPlacesByText } = await client();
    const { merchantCategoryRepository } = await import("../src/repositories/merchantCategoryRepository.js");
    const { inferStoreCategory } = await import("../src/services/categoryInferenceService.js");
    vi.mocked(merchantCategoryRepository.findMany).mockResolvedValueOnce([...ACTIVE, { id: 8, name: "Pasalubong" }] as any);
    google.text = toPlaces([
      raw("t1", "Tacurong Pasalubong Center", 6.69, ["store"]),
      raw("t2", "Mercury Drug", 6.691, ["pharmacy"]),
    ]);
    vi.mocked(searchPlacesByText).mockClear();
    vi.mocked(inferStoreCategory).mockClear();
    const result = await searchEstablishments({ near, categoryId: 8 });

    expect(searchPlacesByText).toHaveBeenCalledWith("Pasalubong");
    expect(result.items.map((e) => [e.name, e.categoryName])).toEqual([["Tacurong Pasalubong Center", "Pasalubong"]]);
    // Its category is known: no model call to guess one.
    expect(inferStoreCategory).not.toHaveBeenCalled();
  });

  it("falls back to the category's name when Google refuses the type search", async () => {
    const { searchPlacesByText } = await client();
    google.nearby = null;
    google.text = toPlaces([raw("t1", "Mercury Drug", 6.69, ["pharmacy"])]);
    vi.mocked(searchPlacesByText).mockClear();
    const result = await searchEstablishments({ near, categoryId: 3 });

    expect(searchPlacesByText).toHaveBeenCalledWith("Pharmacy");
    expect(result).toMatchObject({ google: "ok", items: [expect.objectContaining({ name: "Mercury Drug" })] });
  });

  it("lists a Cafe category's cafes, from a search for cafes alone", async () => {
    const { searchNearbyPlaces } = await client();
    const { merchantCategoryRepository } = await import("../src/repositories/merchantCategoryRepository.js");
    vi.mocked(merchantCategoryRepository.findMany).mockResolvedValueOnce([...ACTIVE, { id: 8, name: "Cafe" }] as any);
    google.nearby = toPlaces([
      raw("c1", "Decent Cup", 6.691, ["cafe", "restaurant"]),
      raw("c2", "Kape Kamaleg", 6.692, ["coffee_shop", "cafe"]),
      raw("r1", "Bambusa Kainan", 6.6905, ["restaurant", "cafe"]),
    ]);
    vi.mocked(searchNearbyPlaces).mockClear();
    const result = await searchEstablishments({ near, categoryId: 8 });

    expect(vi.mocked(searchNearbyPlaces).mock.calls[0][1]).toEqual(["cafe", "coffee_shop"]);
    expect(result.items.map((e) => [e.name, e.categoryName])).toEqual([
      ["Decent Cup", "Cafe"],
      ["Kape Kamaleg", "Cafe"],
    ]);
  });

  it("lists nothing for a category that is switched off, and the Location Stores alone without Google", async () => {
    google.nearby = toPlaces([raw("g1", "Mercury Drug", 6.692, ["pharmacy"])]);
    expect((await searchEstablishments({ near, categoryId: 99 })).items).toEqual([]);

    google.nearby = null;
    catalogue.rows = [place("p1", "Generika Alunan", 6.6902)];
    const result = await searchEstablishments({ near, categoryId: 3 });
    expect(result.google).toBe("unavailable");
    expect(result.items.map((e) => e.name)).toEqual(["Generika Alunan"]);
  });

  it("supports compound categories (including plural names and description-claimed types) and filters out mismatched catalogue places", async () => {
    const { searchNearbyPlaces } = await client();
    const { placeService } = await import("../src/services/placeService.js");
    const { merchantCategoryRepository } = await import("../src/repositories/merchantCategoryRepository.js");
    vi.mocked(merchantCategoryRepository.findMany).mockResolvedValueOnce([
      ...ACTIVE,
      { id: 8, name: "Cafe" },
      // Compound category with plural words ("Restaurants & Cafes") AND description claiming "burger" directly
      { id: 9, name: "Fast Food & Restaurants & Cafes", description: "Burgers, pizza, restaurants, diners, fast-food chains, and cafes." },
    ] as any);

    catalogue.rows = [
      // Constituent category id (1 = Fast Food) and direct category id (9) with omitted `category` object
      { ...place("cat-ff", "Mang Inasal", 6.6901), categoryId: 1, category: undefined as any },
      { ...place("cat-ph", "Wrong Category Drug", 6.6902), categoryId: 3, category: { id: 3, name: "Pharmacy" } },
    ];
    google.nearby = toPlaces([
      raw("r1", "Chiccoi's Diner", 6.691, ["restaurant"]),
      raw("ff1", "Jollibee Tacurong", 6.692, ["fast_food_restaurant"]),
      raw("c1", "Decent Cup", 6.6915, ["cafe"]),
      raw("p1", "Mercury Drug", 6.6905, ["pharmacy"]),
    ]);
    vi.mocked(searchNearbyPlaces).mockClear();
    vi.mocked(placeService.searchPlaces).mockClear();

    const result = await searchEstablishments({ near, categoryId: 9 });
    // Compound category queries catalogue without a single categoryId filter so constituent category rows (e.g. categoryId=1) are included
    expect(placeService.searchPlaces).toHaveBeenCalledWith({});
    expect(vi.mocked(searchNearbyPlaces).mock.calls[0][1]).toEqual([
      "restaurant",
      "fast_food_restaurant",
      "meal_takeaway",
      "cafe",
      "coffee_shop",
      "sandwich_shop",
      "pizza_restaurant",
      "hamburger_restaurant",
    ]);
    expect(result.items.map((e) => [e.name, e.categoryId, e.categoryName])).toEqual([
      ["Mang Inasal", 9, "Fast Food & Restaurants & Cafes"],
      ["Chiccoi's Diner", 9, "Fast Food & Restaurants & Cafes"],
      ["Decent Cup", 9, "Fast Food & Restaurants & Cafes"],
      ["Jollibee Tacurong", 9, "Fast Food & Restaurants & Cafes"],
    ]);
  });
});

describe("non-Pabili query and establishment filtering", () => {
  const near = { latitude: 6.69, longitude: 124.68 };

  it.each([
    "Police outpost",
    "Police station",
    "Stations",
    "Government offices",
    "Network",
    "Internet Cafe",
    "Nightclub",
    "Logistics",
    "Express",
  ])("short-circuits non-Pabili search query '%s' to empty items without calling Google Places", async (query) => {
    const { searchPlacesByText } = await import("../src/lib/places/googlePlacesClient.js");
    google.text = toPlaces([raw("g1", "Decent Cup", 6.69, ["cafe"])]);
    vi.mocked(searchPlacesByText).mockClear();

    const result = await searchEstablishments({ query, near });
    expect(result.items).toEqual([]);
    expect(searchPlacesByText).not.toHaveBeenCalled();
  });

  it("filters out Police outposts/stations, Government offices, Networks, Internet Cafes, Nightclubs, Logistics, and Express outlets from store results while keeping real Pabili stores", async () => {
    google.text = toPlaces([
      raw("p-police", "Tacurong City Police Station", 6.69, ["police", "point_of_interest"]),
      raw("p-outpost", "PNP Community Outpost", 6.69, ["store"]),
      raw("p-gov", "Tacurong City Hall", 6.69, ["local_government_office", "government_office"]),
      raw("p-bir", "BIR Tacurong Office", 6.69, ["store"]),
      raw("p-net", "Sultan Kudarat Cable Network", 6.69, ["telecommunications_service_provider", "store"]),
      raw("p-icafe", "TNC Internet Cafe", 6.69, ["internet_cafe", "cafe"]),
      raw("p-club", "Neon Nightclub & Bar", 6.69, ["night_club", "bar", "restaurant"]),
      raw("p-log", "Fast Cargo Logistics", 6.69, ["courier_service", "store"]),
      raw("p-exp", "J&T Express Tacurong", 6.69, ["store"]),
      raw("p-poi", "Random Uncategorized Landmark", 6.69, ["point_of_interest", "establishment"]),
      raw("p-valid-water", "Aquabest Water Station", 6.69, ["store"]),
      raw("p-valid-drug", "Mercury Drug", 6.69, ["pharmacy"]),
    ]);

    const result = await searchEstablishments({ query: "tacurong", near });
    expect(result.items.map((item) => item.name)).toEqual(["Aquabest Water Station", "Mercury Drug"]);
  });
});

describe("the Stores near you screen's pages (2026-10-11)", () => {
  const near = { latitude: 6.69, longitude: 124.68 };
  const twentyFive = () =>
    toPlaces(Array.from({ length: 25 }, (_, i) => raw(`n${i}`, `Shop ${i}`, 6.69 + (i + 1) * 0.0004, ["pharmacy"])));

  it("keeps Home's four without a page asked for", async () => {
    google.nearby = twentyFive();
    const result = await searchEstablishments({ near });
    expect(result.items.map((e) => e.name)).toEqual(["Shop 0", "Shop 1", "Shop 2", "Shop 3"]);
    expect(result.hasMore).toBe(true);
  });

  it("pages through at most 20, nearest first, each shop once", async () => {
    google.nearby = twentyFive();
    const pages = [];
    for (let offset = 0; offset < 20; offset += 6) pages.push(await searchEstablishments({ near, offset, limit: 6 }));
    const names = pages.flatMap((page) => page.items.map((e) => e.name));
    expect(names).toEqual(Array.from({ length: 20 }, (_, i) => `Shop ${i}`));
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, true, false]);
  });

  it("asks Google once for the row and every page, while the answer is fresh", async () => {
    const { searchNearbyPlaces } = await import("../src/lib/places/googlePlacesClient.js");
    google.nearby = twentyFive();
    vi.mocked(searchNearbyPlaces).mockClear();
    await searchEstablishments({ near, withPhotos: true });
    await searchEstablishments({ near, offset: 6, limit: 6 });
    await searchEstablishments({ near, offset: 12, limit: 6 });
    expect(searchNearbyPlaces).toHaveBeenCalledTimes(1);
  });

  it("does not keep a refusal, and leaves typed searches unpaged", async () => {
    const { searchNearbyPlaces } = await import("../src/lib/places/googlePlacesClient.js");
    google.nearby = null;
    vi.mocked(searchNearbyPlaces).mockClear();
    await searchEstablishments({ near });
    google.nearby = twentyFive();
    expect((await searchEstablishments({ near })).items).toHaveLength(4);
    expect(searchNearbyPlaces).toHaveBeenCalledTimes(2);

    google.text = twentyFive();
    const typed = await searchEstablishments({ query: "shop", near, offset: 6, limit: 2 });
    expect(typed.items.length).toBeGreaterThan(2);
    expect(typed.hasMore).toBeUndefined();
  });
});

describe("street-only road pin filtering and verified catalogue badging (Options 1 & 3)", () => {
  const near = { latitude: 6.69, longitude: 124.68 };

  it("filters out street-only place names while keeping genuine storefronts", async () => {
    const { isStreetOnlyName } = await import("../src/lib/places/googlePlacesClient.js");

    // Road and highway identifiers that should be filtered
    expect(isStreetOnlyName("Lesdema street tacurong city")).toBe(true);
    expect(isStreetOnlyName("Ledesma street")).toBe(true);
    expect(isStreetOnlyName("Ledesma St.")).toBe(true);
    expect(isStreetOnlyName("National Highway")).toBe(true);
    expect(isStreetOnlyName("Tacurong - Isulan Rd")).toBe(true);
    expect(isStreetOnlyName("Alunan Highway")).toBe(true);
    expect(isStreetOnlyName("City of Tacurong")).toBe(true);

    // Real business establishments that should be retained
    expect(isStreetOnlyName("Mercury Drug - Tacurong City Ledesma")).toBe(false);
    expect(isStreetOnlyName("Jollibee National Highway")).toBe(false);
    expect(isStreetOnlyName("MEATDAVE SMOKED&STACKED")).toBe(false);
    expect(isStreetOnlyName("Thundercloud Petshop")).toBe(false);
    expect(isStreetOnlyName("Aquabest Water Station")).toBe(false);
    expect(isStreetOnlyName("Terickfic Special Buko Pie")).toBe(false);
    expect(isStreetOnlyName("Baker's Plaza")).toBe(false);
  });

  it("marks catalogue stores as isVerified: true and pure Google stores as isVerified: false", () => {
    const catStore = fromCatalogue(place("c1", "Curated Local Bakery", 6.69, 4, "Bread & Pastry"), near);
    expect(catStore.isVerified).toBe(true);
    expect(catStore.source).toBe("catalogue");

    const googleStore = fromGoogle(
      {
        googlePlaceId: "g1",
        name: "Google Roadside Store",
        address: "Poblacion, Tacurong",
        latitude: 6.69,
        longitude: 124.68,
        types: ["store"],
        primaryType: "store",
        isOpen: true,
        photo: null,
        rating: null,
        ratingCount: null,
      },
      null,
      near
    );
    expect(googleStore.isVerified).toBe(false);
    expect(googleStore.source).toBe("google");
  });

  it("preserves isVerified: true when merging catalogue store with matching Google Place", () => {
    const catStore = fromCatalogue(place("c1", "Mercury Drug", 6.69, 3, "Pharmacy"), near);
    const googleStore = fromGoogle(
      {
        googlePlaceId: "g1",
        name: "Mercury Drug",
        address: "Mabini St, Tacurong",
        latitude: 6.69,
        longitude: 124.68,
        types: ["pharmacy"],
        primaryType: "pharmacy",
        isOpen: true,
        photo: { name: "places/g1/photos/ph1", attribution: "Contributor" },
        rating: 4.8,
        ratingCount: 150,
      },
      { id: 3, name: "Pharmacy" },
      near
    );

    const merged = mergeEstablishments([catStore], [googleStore]);
    expect(merged).toHaveLength(1);
    expect(merged[0].isVerified).toBe(true);
    expect(merged[0].source).toBe("catalogue");
    expect(merged[0].photoName).toBe("places/g1/photos/ph1");
    expect(merged[0].rating).toBe(4.8);
  });
});


describe("typed searches and Google's bill (2026-10-13)", () => {
  const near = { latitude: 6.69, longitude: 124.68 };

  it("asks Google nothing for two letters, and once for a word typed twice", async () => {
    const { searchPlacesByText } = await import("../src/lib/places/googlePlacesClient.js");
    google.text = toPlaces([raw("g1", "Mercury Drug", 6.69, ["pharmacy"])]);
    vi.mocked(searchPlacesByText).mockClear();

    await searchEstablishments({ query: "me", near });
    expect(searchPlacesByText).not.toHaveBeenCalled();

    const first = await searchEstablishments({ query: "Mercury", near });
    const again = await searchEstablishments({ query: "mercury ", near });
    expect(searchPlacesByText).toHaveBeenCalledTimes(1);
    expect(again.items.map((e) => e.name)).toEqual(first.items.map((e) => e.name));
  });
});

describe("a store the owner registered (2026-10-13)", () => {
  const near = { latitude: 6.69, longitude: 124.68 };

  it("shows the owner's photo instead of paying for Google's, keeps the store's id, and follows the owner's hours", async () => {
    const { resolvePhotoUris } = await import("../src/lib/places/placePhotos.js");
    google.nearby = toPlaces([raw("g1", "Mercury Drug", 6.69, ["pharmacy"], { photos: [{ name: "places/g1/photos/p1" }] })]);
    owners.rows = [
      {
        id: "store-1",
        googlePlaceId: "g1",
        isActive: true,
        photoUpdatedAt: new Date("2026-10-13T01:00:00Z"),
        // Closed every day: the owner's word beats Google's and every estimate.
        openingHours: { days: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: true, open: "", close: "" })) },
      },
    ];
    vi.mocked(resolvePhotoUris).mockClear();
    const result = await searchEstablishments({ near, withPhotos: true, photoOrigin: "https://api.example.org" });
    const store = result.items.find((e) => e.googlePlaceId === "g1")!;
    expect(store.photoUrl).toBe(`https://api.example.org/api/places/store-1/photo?v=${Date.parse("2026-10-13T01:00:00Z")}`);
    expect(vi.mocked(resolvePhotoUris).mock.calls[0][0]).toEqual([null]);
    expect(store.placeId).toBe("store-1");
    expect(store.isOpen).toBe(false);
    expect(store.closedReason).toBe("Temporarily Unavailable");
  });
});

describe("the owner's stores in Stores near you (2026-10-13)", () => {
  const near = { latitude: 6.69, longitude: 124.68 };

  it("lists a nearby Location Store Google Maps does not have, without typing its name", async () => {
    google.nearby = toPlaces([raw("g1", "Mercury Drug", 6.6901, ["pharmacy"])]);
    catalogue.rows = [place("c1", "Arabian Spice Restaurant", 6.6902, 2, "Restaurant"), place("far", "Far Away Store", 6.75)];
    const result = await searchEstablishments({ near, offset: 0, limit: 20 });
    const names = result.items.map((e) => e.name);
    expect(names).toContain("Arabian Spice Restaurant");
    expect(names).toContain("Mercury Drug");
    // About 6.7 km off: not "near you".
    expect(names).not.toContain("Far Away Store");
  });
});
