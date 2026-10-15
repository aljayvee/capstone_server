import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ceiling on Google Places spending (2026-10-13): requests are counted per
 * SKU and month, one past the free allowance so far is refused, and the counts
 * outlive a restart.
 */

vi.mock("../src/config/env.js", async (original) => ({
  ...(await original<typeof import("../src/config/env.js")>()),
  GOOGLE_PLACES_API_KEY: "test-places-key",
}));

import {
  allowanceSoFar,
  billingMonth,
  configurePlacesBudget,
  hasPlacesAllowance,
  placesUsage,
  spendPlacesRequest,
} from "../src/lib/places/placesBudget.js";
import { googleOpenNowAt, searchNearbyPlaces, searchPopularPlaces } from "../src/lib/places/googlePlacesClient.js";

// Day 15 of October's 31 by Google's (Pacific) clock.
const MID_OCTOBER = new Date("2026-10-15T20:00:00Z");
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "places-budget-"));
  file = path.join(dir, "places-usage.json");
  configurePlacesBudget({ enabled: true, file });
});
afterEach(() => {
  configurePlacesBudget({ enabled: false });
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("the free-tier ceiling", () => {
  it("bills by Google's clock: 1 November in Manila is still October in California", () => {
    expect(billingMonth(new Date("2026-11-01T02:00:00Z"))).toBe("2026-10");
    expect(billingMonth(new Date("2026-11-01T09:00:00Z"))).toBe("2026-11");
  });

  it("builds up day by day to nine tenths of the free allowance", () => {
    // 15 of 31 days of 900 photos.
    expect(allowanceSoFar("photo", MID_OCTOBER)).toBe(Math.floor((1000 * 0.9 * 15) / 31));
    expect(allowanceSoFar("nearbyPro", new Date("2026-10-31T20:00:00Z"))).toBe(4500);
  });

  it("refuses the request past the allowance so far, and only that SKU", () => {
    const allowed = allowanceSoFar("photo", MID_OCTOBER);
    for (let i = 0; i < allowed; i++) expect(spendPlacesRequest("photo", MID_OCTOBER)).toBe(true);
    expect(spendPlacesRequest("photo", MID_OCTOBER)).toBe(false);
    expect(hasPlacesAllowance("photo", MID_OCTOBER)).toBe(false);
    expect(hasPlacesAllowance("nearbyPro", MID_OCTOBER)).toBe(true);
    // The next day adds that day's share.
    expect(spendPlacesRequest("photo", new Date("2026-10-16T20:00:00Z"))).toBe(true);
  });

  it("keeps its counts through a restart, and starts again with a new month", () => {
    spendPlacesRequest("textPro", MID_OCTOBER);
    spendPlacesRequest("textPro", MID_OCTOBER);
    configurePlacesBudget({ enabled: true, file }); // a restart: memory gone, file kept
    expect(placesUsage(MID_OCTOBER).skus.find((s) => s.sku === "textPro")?.used).toBe(2);
    expect(placesUsage(new Date("2026-11-05T20:00:00Z")).skus.find((s) => s.sku === "textPro")?.used).toBe(0);
  });
});

describe("Google requests under the ceiling", () => {
  const google = vi.fn();
  beforeEach(() => {
    google.mockReset();
    google.mockResolvedValue({ ok: true, status: 200, json: async () => ({ places: [] }) });
    vi.stubGlobal("fetch", google);
  });
  const maskOf = (call: number) => google.mock.calls[call][1].headers["X-Goog-FieldMask"] as string;

  it("asks the nearby list on the Pro tier: no opening hours, no ratings", async () => {
    await searchNearbyPlaces({ latitude: 6.69, longitude: 124.67 });
    expect(maskOf(0)).not.toMatch(/OpeningHours|rating/);
    expect(placesUsage().skus.find((s) => s.sku === "nearbyPro")?.used).toBe(1);
  });

  it("asks the popular search for ratings until the Enterprise allowance is used, then on the Pro tier", async () => {
    await searchPopularPlaces({ latitude: 6.69, longitude: 124.67 });
    expect(maskOf(0)).toMatch(/places\.rating/);
    expect(maskOf(0)).toMatch(/nextCloseTime/);

    const allowed = allowanceSoFar("nearbyEnterprise");
    while (spendPlacesRequest("nearbyEnterprise"));
    expect(placesUsage().skus.find((s) => s.sku === "nearbyEnterprise")?.used).toBe(allowed);
    await searchPopularPlaces({ latitude: 6.69, longitude: 124.67 });
    expect(maskOf(1)).not.toMatch(/rating/);
  });

  it("sends nothing at all once a SKU is used up, answering as if Google were down", async () => {
    while (spendPlacesRequest("nearbyPro"));
    expect(await searchNearbyPlaces({ latitude: 6.69, longitude: 124.67 })).toBeNull();
    expect(google).not.toHaveBeenCalled();
  });
});

describe("a kept open-now answer", () => {
  const at = new Date("2026-10-15T12:00:00Z");
  it("closes at the closing time Google gave, and opens at the opening time", () => {
    expect(googleOpenNowAt({ openNow: true, nextCloseTime: "2026-10-15T11:00:00Z" }, at)).toBe(false);
    expect(googleOpenNowAt({ openNow: true, nextCloseTime: "2026-10-15T13:00:00Z" }, at)).toBe(true);
    expect(googleOpenNowAt({ openNow: false, nextOpenTime: "2026-10-15T11:59:00Z" }, at)).toBe(true);
    expect(googleOpenNowAt({ openNow: null }, at)).toBeNull();
  });
});
