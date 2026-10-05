import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A new order's items go to the category service when the order is placed.
 *
 * For a name its own model is unsure of, the service asks Gemma 4, which takes
 * seconds, longer than a dispatcher's request is allowed to wait. Asked at
 * order time, the answer is cached before anyone opens the order. The call is
 * fire and forget: order creation never waits on it and never fails with it.
 */

process.env.CATEGORY_SERVICE_URL = "http://category.test";
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { warmItemCategories } = await import("../src/lib/category/categoryServiceClient.js");

beforeEach(() => {
  fetchMock.mockReset();
});

describe("warming a new order's items", () => {
  it("sends the trimmed names, at most 100, and returns without waiting", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({ unsure: 2 }) });

    const returned = warmItemCategories([" Pandesal (10pcs) ", "", "Neozep forte", ...Array(120).fill("x")]);

    expect(returned).toBeUndefined();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://category.test/warm");
    const body = JSON.parse(init.body);
    expect(body.kind).toBe("item");
    expect(body.names.slice(0, 2)).toEqual(["Pandesal (10pcs)", "Neozep forte"]);
    expect(body.names).toHaveLength(100);
  });

  it("does not call for an order with no named items", () => {
    warmItemCategories(["", "   "]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a dead service rather than failing the order", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect(() => warmItemCategories(["Pandesal"])).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
