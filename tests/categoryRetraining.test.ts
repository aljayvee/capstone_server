import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the category auto-learning actually sends. Until 2026-09-24 it only
// POSTed /reload, which re-read the same model files, so nothing was learned.

vi.mock("../src/config/env.js", () => ({
  CATEGORY_SERVICE_URL: "http://category.test",
  CATEGORY_SERVICE_TIMEOUT_MS: 1500,
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    merchantCategory: { findMany: vi.fn() },
    verifiedPlace: { findMany: vi.fn() },
    errandPinpoint: { findMany: vi.fn(), count: vi.fn() },
    pabiliDetail: { findMany: vi.fn() },
    pabiliItemRequest: { findMany: vi.fn() },
  },
}));

import { prisma } from "../src/lib/prisma.js";
import {
  collectCategoryTrainingRows,
  ensureCategoryModelsCurrent,
  executeCategoryRetrain,
  resetCategorySelfHealForTests,
  staleModelReasons,
} from "../src/services/categoryRetrainingService.js";

const db = prisma as unknown as Record<string, { findMany: ReturnType<typeof vi.fn> }>;

beforeEach(() => {
  db.merchantCategory.findMany.mockResolvedValue([
    { name: "Bakery", description: "Bread, cakes and pastries" },
    { name: "Pharmacy & Health", description: null },
    { name: "  " },
  ]);
  db.verifiedPlace.findMany.mockResolvedValue([
    { name: "Julie's Bakeshop", keywords: "julies, jb, julie bakeshop", category: { name: "Bakery" } },
  ]);
  db.errandPinpoint.findMany.mockResolvedValue([
    { storeName: "Rojon pharmacy", category: { name: "Pharmacy & Health" } },
    { storeName: "Rojon pharmacy", category: { name: "Pharmacy & Health" } },
    { storeName: "   ", category: { name: "Bakery" } },
  ]);
  db.pabiliDetail.findMany.mockResolvedValue([
    { itemName: "pandesal", storeCategory: "Store 2 - Julie's Bakeshop | Bakery" },
  ]);
  db.pabiliItemRequest.findMany.mockResolvedValue([
    { itemName: "Paracetamol 500mg", storeCategory: "Pharmacy & Health" },
    { itemName: "Mystery", storeCategory: "" },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collectCategoryTrainingRows", () => {
  it("reads the catalogue, aliases, every pin and both item tables the way the trainer does", async () => {
    const rows = await collectCategoryTrainingRows();
    expect(rows.categories).toEqual(["Bakery", "Pharmacy & Health"]);
    expect(rows.stores).toEqual([
      ["Julie's Bakeshop", "Bakery"],
      ["julies", "Bakery"],
      // "jb" is under three characters and dropped, as in train.py
      ["julie bakeshop", "Bakery"],
      ["Rojon pharmacy", "Pharmacy & Health"],
      ["Rojon pharmacy", "Pharmacy & Health"], // two pins are two votes
    ]);
    expect(rows.items).toEqual([
      ["pandesal", "Bakery"], // the part after " | "
      ["Paracetamol 500mg", "Pharmacy & Health"],
    ]);
  });
});

describe("executeCategoryRetrain", () => {
  it("sends the rows to /retrain", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await executeCategoryRetrain(["created"])).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://category.test/retrain");
    const body = JSON.parse(init.body);
    expect(body.reasons).toEqual(["created"]);
    expect(body.categories).toContain("Bakery");
    expect(body.stores).toHaveLength(5);
    // The descriptions travel too: they teach a category the owner created.
    expect(body.descriptions).toEqual({ Bakery: "Bread, cakes and pastries", "Pharmacy & Health": "" });
  });

  it("falls back to /reload on a container that predates /retrain", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: "ok" }) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await executeCategoryRetrain(["nightly"])).toBe(true);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "http://category.test/retrain",
      "http://category.test/reload",
    ]);
  });

  it("never throws when the service is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await executeCategoryRetrain(["nightly"])).toBe(false);
  });
});

describe("staleModelReasons", () => {
  const healthy = {
    ready: true,
    training: { state: "idle" },
    models: {
      store: { real_rows: 18, classes: ["Bakery", "Fast Food & Restaurant"] },
      item: { real_rows: 56, classes: ["Bakery", "Fast Food & Restaurant"] },
    },
  };

  it("is quiet when every active category is served", () => {
    expect(staleModelReasons(healthy, ["Bakery", "Fast Food & Restaurant"], 18)).toEqual([]);
  });

  it("names the categories a rebuilt, seed-only model lacks", () => {
    const seedOnly = {
      ...healthy,
      models: {
        store: { real_rows: 0, classes: ["Fast Food & Restaurant"] },
        item: { real_rows: 0, classes: ["Fast Food & Restaurant"] },
      },
    };
    expect(staleModelReasons(seedOnly, ["Bakery", "Fast Food & Restaurant"], 18)).toEqual([
      "store model lacks Bakery",
      "item model lacks Bakery",
      "store model learned none of production's own rows",
    ]);
  });

  it("waits for a retrain that is already running", () => {
    expect(staleModelReasons({ ...healthy, training: { state: "training" } }, ["Convenience Store"], 18)).toEqual([]);
  });
});

describe("ensureCategoryModelsCurrent", () => {
  beforeEach(() => resetCategorySelfHealForTests());

  it("retrains once when the served models are stale, and not again within two hours", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith("/health")) {
          return new Response(
            JSON.stringify({
              ready: true,
              training: { state: "idle" },
              models: { store: { real_rows: 0, classes: ["Pharmacy & Health"] }, item: { classes: ["Pharmacy & Health"] } },
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      })
    );
    (db.errandPinpoint as any).count.mockResolvedValue(3);

    const first = await ensureCategoryModelsCurrent(1_000_000);
    expect(first).toContain("store model lacks Bakery");
    expect(calls.filter((u) => u.endsWith("/retrain"))).toHaveLength(1);

    await ensureCategoryModelsCurrent(1_000_000 + 60 * 60 * 1000);
    expect(calls.filter((u) => u.endsWith("/retrain"))).toHaveLength(1);
  });
});
