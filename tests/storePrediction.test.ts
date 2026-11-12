import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, suggestItemPlacements, checkStoreLocation } = vi.hoisted(() => ({
  db: {
    errand: null as any,
    pins: [] as any[],
    places: [] as any[],
    filings: [] as any[],
    categories: [
      { id: 1, name: "Pharmacy & Health" },
      { id: 2, name: "Bakery" },
      { id: 3, name: "Supermarket & Grocery" },
      { id: 4, name: "Retail & General Merchandise" },
    ],
    /** The crawler's review sheet, or null for an install without one. */
    crawl: null as string | null,
    /** The owner's rate card; only maxAdditionalStores is read here. */
    rateConfig: { maxAdditionalStores: 2 } as any,
  },
  suggestItemPlacements: vi.fn(),
  checkStoreLocation: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errand: { findUnique: vi.fn(async () => db.errand) },
    errandPinpoint: { findMany: vi.fn(async () => db.pins) },
    verifiedPlace: { findMany: vi.fn(async () => db.places) },
    pabiliDetail: { findMany: vi.fn(async () => db.filings) },
    merchantCategory: { findMany: vi.fn(async () => db.categories) },
  },
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    if (db.crawl === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return db.crawl;
  }),
}));
vi.mock("../src/services/itemPlacementService.js", () => ({ suggestItemPlacements }));
vi.mock("../src/services/storeLocationGuard.js", () => ({ checkStoreLocation }));
vi.mock("../src/lib/rateConfigCache.js", () => ({ getCachedRateConfig: vi.fn(async () => db.rateConfig) }));

import {
  forgetStorePredictionMemory,
  normalizeStoreName,
  parseCrawledPlaces,
  predictStores,
} from "../src/services/storePredictionService.js";

const today = new Date();
const MERCURY = { storeName: "Mercury Drug Tacurong", latitude: 6.6871, longitude: 124.6755, placeId: null, categoryId: 1 };
const ROJON = { storeName: "Rojon pharmacy", latitude: 6.6921, longitude: 124.6701, placeId: null, categoryId: 1 };
const JULIES = {
  storeName: "Julie's Bakeshop Mabini-Dona Alicia, Poblacion, Tacurong",
  latitude: 6.6852,
  longitude: 124.6789,
  placeId: null,
  categoryId: 2,
};

const pin = (store: any) => ({ ...store, createdAt: today });
const filing = (errandId: string, itemName: string, store: any) => ({
  errandId,
  itemName,
  createdAt: today,
  pinpoint: store,
});
const noCategory = (names: string[]) =>
  names.map((name) => ({ name, categoryId: null, categoryName: null, confidence: 0, source: "none" }));

beforeEach(() => {
  forgetStorePredictionMemory();
  db.rateConfig = { maxAdditionalStores: 2 };
  db.errand = {
    id: "e-now",
    deliveryLatitude: 6.688,
    deliveryLongitude: 124.676,
    pinpoints: [],
    pabiliDetails: [],
    pabiliItemRequests: [{ itemName: "Biogesic" }, { itemName: "Pandesal" }],
  };
  db.pins = [];
  db.places = [];
  db.filings = [];
  db.crawl = null;
  suggestItemPlacements.mockReset().mockImplementation(async (_: string, names: string[]) => noCategory(names));
  checkStoreLocation.mockReset().mockResolvedValue({ status: "inside", reason: "inside_border", kmBeyondBorder: 0 });
});

describe("predictStores", () => {
  it("proposes the store dispatchers filed each item under, one store per kind of shop", async () => {
    db.pins = [pin(MERCURY), pin(JULIES), pin(MERCURY)];
    db.filings = [
      filing("e-1", "Biogesic 500mg", MERCURY),
      filing("e-2", "biogesic", MERCURY),
      filing("e-3", "Pandesal (10pcs)", JULIES),
    ];

    const result = await predictStores("e-now");

    expect(result.stores.map((s) => s.storeName).sort()).toEqual(["Julie's Bakeshop Mabini-Dona Alicia", "Mercury Drug Tacurong"]);
    const mercury = result.stores.find((s) => s.storeName.startsWith("Mercury"))!;
    expect(mercury.items).toEqual(["Biogesic"]);
    expect(mercury.source).toBe("learned");
    expect(mercury.learnedFrom).toBe(2);
    expect(result.uncovered).toEqual([]);
    expect(result.trainingExamples).toBe(3);
  });

  it("learns a correction: once dispatchers file an item elsewhere, the prediction follows", async () => {
    db.pins = [pin(MERCURY), pin(ROJON)];
    db.errand.pabiliItemRequests = [{ itemName: "Robust Extreme" }];
    db.filings = [filing("e-1", "Robust Extreme", MERCURY)];
    expect((await predictStores("e-now")).stores[0].storeName).toBe("Mercury Drug Tacurong");

    // The dispatcher said "not accurate" and filed it under Rojon, twice.
    db.filings = [
      filing("e-3", "Robust Extreme", ROJON),
      filing("e-2", "Robust Extreme", ROJON),
      filing("e-1", "Robust Extreme", MERCURY),
    ];
    forgetStorePredictionMemory();
    expect((await predictStores("e-now")).stores[0].storeName).toBe("Rojon pharmacy");
  });

  it("never learns from the errand being asked about", async () => {
    db.pins = [pin(MERCURY)];
    db.filings = [filing("e-now", "Biogesic", MERCURY)];
    const result = await predictStores("e-now");
    expect(result.stores).toEqual([]);
    expect(result.uncovered.map((u) => u.name)).toEqual(["Biogesic", "Pandesal"]);
  });

  it("borrows history from an item sharing most of its words", async () => {
    db.pins = [pin(JULIES)];
    db.errand.pabiliItemRequests = [{ itemName: "Spanish bread" }];
    db.filings = [filing("e-1", "Spanish bread loaf", JULIES)];
    const [store] = (await predictStores("e-now")).stores;
    expect(store.source).toBe("similar");
    expect(store.storeName).toMatch(/^Julie's/);
  });

  it("falls back to the most-used store of the item's category, nearest the customer", async () => {
    db.pins = [pin(ROJON), pin(MERCURY), pin(MERCURY), pin(MERCURY)];
    db.errand.pabiliItemRequests = [{ itemName: "Losartan" }];
    suggestItemPlacements.mockResolvedValue([
      { name: "Losartan", categoryId: 1, categoryName: "Pharmacy & Health", confidence: 0.9, source: "model" },
    ]);
    const [store] = (await predictStores("e-now")).stores;
    expect(store.source).toBe("category");
    expect(store.storeName).toBe("Mercury Drug Tacurong");
    expect(store.reason).toMatch(/Pharmacy & Health/);
  });

  it("never proposes a store the location guard blocks", async () => {
    db.pins = [pin(MERCURY)];
    db.errand.pabiliItemRequests = [{ itemName: "Biogesic" }];
    db.filings = [filing("e-1", "Biogesic", MERCURY)];
    checkStoreLocation.mockResolvedValue({ status: "blocked", reason: "off_road_map", kmBeyondBorder: 40 });
    const result = await predictStores("e-now");
    expect(result.stores).toEqual([]);
    expect(result.uncovered).toHaveLength(1);
  });

  it("ignores junk pin names like 'Unnamed Road'", async () => {
    const junk = { storeName: "Unnamed Road", latitude: 6.69, longitude: 124.67, placeId: null, categoryId: 3 };
    db.pins = [pin(junk)];
    db.errand.pabiliItemRequests = [{ itemName: "Fried Chicken" }];
    db.filings = [filing("e-1", "Fried Chicken (2pc)", junk)];
    expect((await predictStores("e-now")).stores).toEqual([]);
  });

  it("uses the names the screen sends over the saved list", async () => {
    db.pins = [pin(JULIES)];
    db.filings = [filing("e-1", "Ensaymada", JULIES)];
    const result = await predictStores("e-now", ["Ensaymada"]);
    expect(result.stores[0].items).toEqual(["Ensaymada"]);
  });

  it("says so when an item lost out to the three-store limit", async () => {
    const shop = (name: string, lat: number, categoryId: number) => ({
      storeName: name, latitude: lat, longitude: 124.67, placeId: null, categoryId,
    });
    db.pins = [pin(shop("Alpha Drug", 6.681, 1)), pin(shop("Beta Bakery", 6.682, 2)), pin(shop("Gamma Mart", 6.683, 3)), pin(shop("Kimsan Plaza", 6.684, 4))];
    db.errand.pabiliItemRequests = [{ itemName: "a1" }, { itemName: "b1" }, { itemName: "c1" }, { itemName: "d1" }];
    suggestItemPlacements.mockImplementation(async (_: string, names: string[]) =>
      names.map((name, i) => ({ name, categoryId: i + 1, categoryName: `Category ${i + 1}`, confidence: 0.9 - i * 0.1, source: "model" }))
    );
    const result = await predictStores("e-now");
    expect(result.stores).toHaveLength(3);
    expect(result.uncovered).toHaveLength(1);
    expect(result.uncovered[0].reason).toMatch(/most one errand can have/);
  });

  it("stops at three stores", async () => {
    const stores = [0, 1, 2, 3].map((i) => ({
      storeName: `Shop ${String.fromCharCode(65 + i)}`,
      latitude: 6.68 + i * 0.005,
      longitude: 124.67,
      placeId: null,
      categoryId: 3,
    }));
    db.pins = stores.map(pin);
    db.errand.pabiliItemRequests = stores.map((_, i) => ({ itemName: `thing${i}` }));
    db.filings = stores.map((s, i) => filing(`e-${i}`, `thing${i}`, s));
    const result = await predictStores("e-now");
    expect(result.stores).toHaveLength(3);
    expect(result.uncovered).toHaveLength(1);
  });

  it("follows the owner's Max Additional Stores Allowed, not a fixed three (2026-10-25)", async () => {
    db.rateConfig = { maxAdditionalStores: 4 };
    const stores = [0, 1, 2, 3, 4, 5].map((i) => ({
      storeName: `Shop ${String.fromCharCode(65 + i)}`,
      latitude: 6.68 + i * 0.005,
      longitude: 124.67,
      placeId: null,
      categoryId: 3,
    }));
    db.pins = stores.map(pin);
    db.errand.pabiliItemRequests = stores.map((_, i) => ({ itemName: `thing${i}` }));
    db.filings = stores.map((s, i) => filing(`e-${i}`, `thing${i}`, s));
    const result = await predictStores("e-now");
    expect(result.stores).toHaveLength(5);
    expect(result.uncovered).toHaveLength(1);
  });
});

// ── the map: Tacurong places from the OpenStreetMap crawl ─────────────────

const CRAWL_HEADER =
  "name,lat,lon,osm,mapper_category,model_category,confidence,final_category,needs_review,agrees_with_mappers,reason";
const crawlRow = (name: string, lat: number, lon: number, mapper: string, model: string, review: "yes" | "no") =>
  `"${name}",${lat},${lon},node/1,${mapper},${model},0.9,${mapper || model},${review},,reason`;

describe("the map (OpenStreetMap crawl)", () => {
  const hammer = [
    { name: "Hammer", categoryId: 4, categoryName: "Retail & General Merchandise", confidence: 0.9, source: "model" },
  ];

  it("proposes a mapped shop for a kind of shop nobody has pinned, and says where it came from", async () => {
    db.errand.pabiliItemRequests = [{ itemName: "Hammer" }];
    suggestItemPlacements.mockResolvedValue(hammer);
    db.crawl = [
      CRAWL_HEADER,
      crawlRow("Far Hardware", 6.73, 124.7, "Retail & General Merchandise", "", "yes"),
      crawlRow("Tacurong Builders Hardware", 6.689, 124.677, "Retail & General Merchandise", "", "yes"),
    ].join("\n");

    const [store] = (await predictStores("e-now")).stores;
    expect(store.storeName).toBe("Tacurong Builders Hardware");
    expect(store.source).toBe("category");
    expect(store.reason).toMatch(/OpenStreetMap/);
    expect(store.reason).not.toMatch(/used most/);
  });

  it("still proposes the mapped bakeries after Bakery is renamed", async () => {
    // The sheet says "Bakery"; the owner has since renamed the category. By
    // exact name the mapped bakeries matched nothing and dropped out.
    const original = db.categories;
    db.categories = original.map((c) => (c.name === "Bakery" ? { ...c, name: "Breads & Pastries" } : c));
    try {
      db.errand.pabiliItemRequests = [{ itemName: "Pandesal" }];
      suggestItemPlacements.mockResolvedValue([
        { name: "Pandesal", categoryId: 2, categoryName: "Breads & Pastries", confidence: 0.95, source: "model" },
      ]);
      db.crawl = [CRAWL_HEADER, crawlRow("Honesty Bakeshop", 6.6878, 124.6785, "Bakery", "", "no")].join("\n");

      const [store] = (await predictStores("e-now")).stores;
      expect(store.storeName).toBe("Honesty Bakeshop");
      expect(store.items).toEqual(["Pandesal"]);
    } finally {
      db.categories = original;
    }
  });

  it("never outranks a store dispatchers have actually used", async () => {
    const USED = { storeName: "Kimsan Plaza", latitude: 6.70, longitude: 124.69, placeId: null, categoryId: 4 };
    db.pins = [pin(USED)];
    db.errand.pabiliItemRequests = [{ itemName: "Hammer" }];
    suggestItemPlacements.mockResolvedValue(hammer);
    db.crawl = [CRAWL_HEADER, crawlRow("Nearby Hardware", 6.6881, 124.6761, "Retail & General Merchandise", "", "yes")].join("\n");

    const [store] = (await predictStores("e-now")).stores;
    expect(store.storeName).toBe("Kimsan Plaza");
    expect(store.reason).toMatch(/used most/);
  });

  it("an install without a crawl predicts exactly as before", async () => {
    db.errand.pabiliItemRequests = [{ itemName: "Hammer" }];
    suggestItemPlacements.mockResolvedValue(hammer);
    const result = await predictStores("e-now");
    expect(result.stores).toEqual([]);
    expect(result.uncovered[0].reason).toMatch(/pinned or mapped yet/);
  });
});

describe("parseCrawledPlaces", () => {
  it("keeps what a mapper tagged or the model filed without review, the mapper's tag first", () => {
    const places = parseCrawledPlaces(
      [
        CRAWL_HEADER,
        crawlRow("Julie's Bakeshop, Poblacion", 6.68, 124.67, "Bakery", "Fast Food & Restaurant", "yes"),
        crawlRow("Sure Pharmacy", 6.69, 124.68, "", "Pharmacy & Health", "no"),
        crawlRow("Unsure Shop", 6.69, 124.68, "", "Retail & General Merchandise", "yes"),
        `"No Position",,,node/2,Bakery,Bakery,0.9,Bakery,no,yes,reason`,
      ].join("\n")
    );
    expect(places).toEqual([
      { storeName: "Julie's Bakeshop, Poblacion", latitude: 6.68, longitude: 124.67, categoryName: "Bakery" },
      { storeName: "Sure Pharmacy", latitude: 6.69, longitude: 124.68, categoryName: "Pharmacy & Health" },
    ]);
  });

  it("returns nothing for a file with the wrong columns", () => {
    expect(parseCrawledPlaces("a,b,c\n1,2,3")).toEqual([]);
  });
});

describe("normalizeStoreName", () => {
  it("meets repeat pins of one shop under one key", () => {
    expect(normalizeStoreName("NCCC Supermarket Tacurong City")).toBe(normalizeStoreName("NCCC Supermarket"));
    expect(normalizeStoreName("Julie's Bakeshop Mabini-Dona Alicia, Poblacion, Tacurong")).toBe(
      "julie s bakeshop mabini dona alicia"
    );
  });
});

describe("an item that names the store", () => {
  const JOLLIBEE = { storeName: "Jollibee Tacurong DT", latitude: 6.689, longitude: 124.677, placeId: null, categoryId: null };
  const CAFE = { storeName: "Wednesday's Cafe", latitude: 6.69, longitude: 124.675, placeId: null, categoryId: 4 };

  beforeEach(() => {
    db.pins = [pin(JOLLIBEE), pin(CAFE), pin(CAFE)];
  });

  it("goes to the named store even misspelled, over the category's most-used shop", async () => {
    db.errand.pabiliItemRequests = [{ itemName: "Jolibee Bucket chicken" }];
    suggestItemPlacements.mockResolvedValue([
      { name: "Jolibee Bucket chicken", categoryId: 4, categoryName: "Fast Food & Restaurant", confidence: 0.9, source: "model" },
    ]);
    const [store] = (await predictStores("e-now")).stores;
    expect(store.storeName).toBe("Jollibee Tacurong DT");
    expect(store.source).toBe("named");
  });

  it("does not match on words that only say what kind of shop it is", async () => {
    db.pins = [pin(JULIES)];
    db.errand.pabiliItemRequests = [{ itemName: "Bakeshop bread" }];
    expect((await predictStores("e-now")).stores).toEqual([]);
  });

  it("never takes a typo in the first letter: paint is not Saint Louis Hospital", async () => {
    db.pins = [pin({ storeName: "Saint Louis Hospital", latitude: 6.69, longitude: 124.67, placeId: null, categoryId: 1 })];
    db.errand.pabiliItemRequests = [{ itemName: "Paint brush" }];
    expect((await predictStores("e-now")).stores).toEqual([]);
  });

  it("does not match items against the names of mapped places", async () => {
    db.pins = [];
    db.crawl = [CRAWL_HEADER, crawlRow("Jollibee Koronadal", 6.69, 124.67, "Fast Food & Restaurant", "", "yes")].join("\n");
    db.errand.pabiliItemRequests = [{ itemName: "Jollibee spaghetti" }];
    expect((await predictStores("e-now")).stores).toEqual([]);
  });

  it("allows one typo only on longer words, so short words cannot collide", async () => {
    db.pins = [pin({ storeName: "Mang Inasal", latitude: 6.69, longitude: 124.67, placeId: null, categoryId: null })];
    db.errand.pabiliItemRequests = [{ itemName: "Mani snacks" }];
    expect((await predictStores("e-now")).stores).toEqual([]);
  });
});

describe("store numbers are not brands", () => {
  it("does not send an item mentioning 7777 to 'Store 7777 Mart'", async () => {
    db.pins = [pin({ storeName: "Shop 7777 Mart", latitude: 6.69, longitude: 124.67, placeId: null, categoryId: null })];
    db.errand.pabiliItemRequests = [{ itemName: "Promo code 7777" }];
    expect((await predictStores("e-now")).stores).toEqual([]);
  });
});
