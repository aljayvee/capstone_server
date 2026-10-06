import { describe, expect, it, vi } from "vitest";

/**
 * POST /api/errands/item-stores: which kind of store usually sells each item,
 * for the customer's store editor ("Biogesic is usually bought at Pharmacy &
 * Health"). The answer is the dispatcher console's own item model, reduced to
 * what the app needs and index-aligned with the names sent.
 */

const inferItemCategories = vi.fn();
vi.mock("../src/services/categoryInferenceService.js", () => ({ inferItemCategories }));

const { checkItemStores } = await import("../src/controllers/errandController.js");
const { itemStoreCheckBodySchema } = await import("../src/validators/itemTidyValidators.js");

async function call(body: unknown) {
  const json = vi.fn();
  const next = vi.fn();
  checkItemStores({ body } as any, { json } as any, next);
  await vi.waitFor(() => expect(json.mock.calls.length + next.mock.calls.length).toBe(1));
  return { body: json.mock.calls[0]?.[0], error: next.mock.calls[0]?.[0] };
}

describe("checking which store sells each item", () => {
  it("answers each name with its usual store, in the order sent", async () => {
    inferItemCategories.mockResolvedValueOnce([
      { available: true, categoryId: 2, categoryName: "Pharmacy & Health", confidence: 0.96, strong: true, source: "name", alternatives: [], reason: "" },
      { available: true, category: null, confidence: 0.31, reason: "Unsure" },
      { available: false, reason: "The category service is not reachable." },
    ]);

    const { body } = await call({ names: ["Biogesic", "zzq", "Rice"] });

    expect(inferItemCategories).toHaveBeenCalledWith(["Biogesic", "zzq", "Rice"]);
    expect(body).toEqual({
      results: [
        { category: "Pharmacy & Health", confidence: 0.96, strong: true },
        { category: null, confidence: 0.31, strong: false },
        { category: null, confidence: 0, strong: false },
      ],
    });
  });

  it("refuses an empty list, a 21st item and a blank name", () => {
    expect(() => itemStoreCheckBodySchema.parse({ names: [] })).toThrow();
    expect(() => itemStoreCheckBodySchema.parse({ names: Array.from({ length: 21 }, () => "Rice") })).toThrow();
    expect(() => itemStoreCheckBodySchema.parse({ names: ["  "] })).toThrow();
    expect(itemStoreCheckBodySchema.parse({ names: [" Rice "] }).names).toEqual(["Rice"]);
  });
});
