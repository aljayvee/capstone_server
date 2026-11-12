import { beforeEach, describe, expect, it, vi } from "vitest";

const { rate } = vi.hoisted(() => ({ rate: { config: null as any } }));
vi.mock("../src/lib/rateConfigCache.js", () => ({ getCachedRateConfig: vi.fn(async () => rate.config) }));

import { assertWithinStoreLimit, getStoresAllowed, storesAllowedFor } from "../src/lib/storeLimit.js";

// The owner's "Max Additional Stores Allowed" used to change nothing: every
// list was capped at a literal 3 (2026-10-25).
describe("store limit", () => {
  beforeEach(() => {
    rate.config = { maxAdditionalStores: 2 };
  });

  it("is the first store plus the owner's additional stores", async () => {
    rate.config = { maxAdditionalStores: 5 };
    expect(await getStoresAllowed()).toBe(6);
    rate.config = { maxAdditionalStores: 0 };
    expect(await getStoresAllowed()).toBe(1);
  });

  it("falls back to the column default without a rate card, and clamps nonsense", () => {
    expect(storesAllowedFor(undefined)).toBe(3);
    expect(storesAllowedFor(-4)).toBe(1);
    expect(storesAllowedFor(99)).toBe(6);
  });

  it("refuses a list past the limit with 422 and says what the limit is", async () => {
    rate.config = { maxAdditionalStores: 4 };
    await expect(assertWithinStoreLimit(5)).resolves.toBeUndefined();
    await expect(assertWithinStoreLimit(6)).rejects.toMatchObject({
      status: 422,
      message: "An errand can visit up to 5 stores.",
    });
  });

  it("lets an errand filed under a higher limit keep its stops after the owner lowers it", async () => {
    rate.config = { maxAdditionalStores: 1 };
    await expect(assertWithinStoreLimit(4, 4)).resolves.toBeUndefined();
    await expect(assertWithinStoreLimit(5, 4)).rejects.toMatchObject({ status: 422 });
  });
});
