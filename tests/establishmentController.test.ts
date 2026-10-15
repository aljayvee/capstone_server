import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whose order history ranks the Location list. Customers and staff have
 * separate id sequences that overlap, so a dispatcher's id 7 is also some
 * customer's id 7: only a CUSTOMER caller may pass their id to the ranking.
 */

const search = vi.hoisted(() => vi.fn(async () => ({ items: [], google: "ok" })));
const popular = vi.hoisted(() => vi.fn(async () => ({ items: [], google: "ok" })));
vi.mock("../src/services/establishmentService.js", () => ({
  searchEstablishments: search,
  popularEstablishments: popular,
}));

import {
  popularEstablishmentsHandler,
  searchEstablishmentsHandler,
} from "../src/controllers/establishmentController.js";

const call = async (user: { id: unknown; role: string }, query: Record<string, string> = { q: "mercury", lat: "6.69", lng: "124.68" }) => {
  const res = { json: vi.fn() };
  const next = vi.fn();
  searchEstablishmentsHandler({ query, user } as any, res as any, next);
  await vi.waitFor(() => expect(res.json.mock.calls.length + next.mock.calls.length).toBe(1));
  expect(next).not.toHaveBeenCalled();
  return search.mock.calls[0][0] as { customerId: number | null; withPhotos: boolean; categoryId?: number };
};

beforeEach(() => {
  search.mockClear();
  popular.mockClear();
});

describe("the Location search's caller", () => {
  it("ranks a customer's search with their own past orders", async () => {
    expect((await call({ id: 7, role: "CUSTOMER" })).customerId).toBe(7);
  });

  it.each([["DISPATCHER"], ["OWNER"]])("gives a %s search no order history of its own", async (role) => {
    expect((await call({ id: 7, role })).customerId).toBeNull();
  });
});

describe("photos in the reply", () => {
  it("are looked up only when the Home row asks for them", async () => {
    expect((await call({ id: 4, role: "CUSTOMER" }, { lat: "6.69", lng: "124.68", photos: "1" })).withPhotos).toBe(true);
  });

  it("are not looked up for step 1's list, which shows none", async () => {
    expect((await call({ id: 4, role: "CUSTOMER" }, { lat: "6.69", lng: "124.68" })).withPhotos).toBe(false);
  });
});

describe("a merchant category's list", () => {
  it("passes the category Home's tile asked for, and none otherwise", async () => {
    expect((await call({ id: 4, role: "CUSTOMER" }, { lat: "6.69", lng: "124.68", categoryId: "3" })).categoryId).toBe(3);
    search.mockClear();
    expect((await call({ id: 4, role: "CUSTOMER" })).categoryId).toBeUndefined();
  });

  it("passes the Stores near you screen's page", async () => {
    expect(await call({ id: 4, role: "CUSTOMER" }, { lat: "6.69", lng: "124.68", offset: "6", limit: "6" })).toMatchObject({
      offset: 6,
      limit: 6,
    });
  });

  it("refuses a category id that is not a positive whole number", async () => {
    for (const categoryId of ["0", "-2", "pharmacy", "1.5"]) {
      const res = { json: vi.fn() };
      const next = vi.fn();
      searchEstablishmentsHandler({ query: { categoryId }, user: { id: 4, role: "CUSTOMER" } } as any, res as any, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
      expect(res.json).not.toHaveBeenCalled();
    }
  });
});

describe("the Home tab's Popular Stores", () => {
  const callPopular = async (user: { id: unknown; role: string }, query: Record<string, string>) => {
    const res = { json: vi.fn() };
    const next = vi.fn();
    popularEstablishmentsHandler({ query, user } as any, res as any, next);
    await vi.waitFor(() => expect(res.json.mock.calls.length + next.mock.calls.length).toBe(1));
    expect(next).not.toHaveBeenCalled();
    return popular.mock.calls[0][0] as { near: unknown; customerId: number | null; withPhotos: boolean };
  };

  it("passes where the customer is, who they are, and that the row wants photos", async () => {
    const args = await callPopular({ id: 4, role: "CUSTOMER" }, { lat: "6.69", lng: "124.68", photos: "1" });
    expect(args).toEqual({ near: { latitude: 6.69, longitude: 124.68 }, customerId: 4, withPhotos: true, photoOrigin: null });
  });

  it("gives a staff caller no order history, as the search does", async () => {
    expect((await callPopular({ id: 4, role: "DISPATCHER" }, {})).customerId).toBeNull();
  });

  it("passes the screen's page, sort, and optional categoryId", async () => {
    const args = await callPopular({ id: 4, role: "CUSTOMER" }, { offset: "6", limit: "6", sort: "distance", categoryId: "3" });
    expect(args).toMatchObject({ offset: 6, limit: 6, sort: "distance", categoryId: 3 });
  });

  it("refuses a sort it does not know, an invalid categoryId, or a page past 20", async () => {
    for (const query of [{ sort: "cheapest" }, { limit: "50" }, { offset: "-1" }, { categoryId: "0" }, { categoryId: "-1" }]) {
      const res = { json: vi.fn() };
      const next = vi.fn();
      popularEstablishmentsHandler({ query, user: { id: 4, role: "CUSTOMER" } } as any, res as any, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
      expect(res.json).not.toHaveBeenCalled();
    }
  });
});
