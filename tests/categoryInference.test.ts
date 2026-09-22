import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The contract this file defends: the category service is an improvement to a
 * guess, never a dependency of the dispatch flow.
 *
 * A dispatcher pinning a shop at 9pm must not be blocked because a sidecar
 * container is restarting, a model named a category this environment does not
 * have, or the box is simply gone. Every one of those has to come back as
 * "no answer" — the console then shows the amber "Category needed" mark and the
 * dispatcher chooses by hand, exactly as they did before this service existed.
 *
 * Stubbed at the client and repository edges, the same way the other rule tests
 * here are: this exercises the resolving logic, not HTTP and not the database.
 */

const mockPredictStore = vi.fn();
const mockPredictItems = vi.fn();
const mockIsConfigured = vi.fn();
const mockFindCategories = vi.fn();

vi.mock("../src/lib/category/categoryServiceClient.js", () => ({
  isCategoryServiceConfigured: () => mockIsConfigured(),
  predictStoreCategory: (...args: unknown[]) => mockPredictStore(...args),
  predictItemCategories: (...args: unknown[]) => mockPredictItems(...args),
}));

vi.mock("../src/repositories/merchantCategoryRepository.js", () => ({
  merchantCategoryRepository: { findMany: (...args: unknown[]) => mockFindCategories(...args) },
}));

const { inferStoreCategory, inferItemCategories } = await import(
  "../src/services/categoryInferenceService.js"
);

const CATALOGUE = [
  { id: 3, name: "Pharmacy & Health" },
  { id: 4, name: "Supermarket & Grocery" },
  { id: 5, name: "Fast Food & Restaurant" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConfigured.mockReturnValue(true);
  mockFindCategories.mockResolvedValue(CATALOGUE);
});

describe("resolving a guess against this environment's catalogue", () => {
  it("returns the catalogue id for a category the model named", async () => {
    // The model knows NAMES and nothing else. Ids are per-environment, and a
    // model that had learned them would hand staging's ids to production.
    mockPredictStore.mockResolvedValue({
      category: "Pharmacy & Health",
      confidence: 0.91,
      strong: true,
      source: "name",
      alternatives: [{ category: "Supermarket & Grocery", confidence: 0.05 }],
      reason: "Matched the shop name.",
    });

    const result = await inferStoreCategory("Mercury Drug");

    expect(result).toMatchObject({
      available: true,
      categoryId: 3,
      categoryName: "Pharmacy & Health",
      confidence: 0.91,
      strong: true,
    });
  });

  it("matches a category name regardless of case and surrounding space", async () => {
    mockPredictStore.mockResolvedValue({
      category: "  pharmacy & HEALTH ",
      confidence: 0.9,
      source: "name",
      alternatives: [],
      reason: "",
    });

    expect(await inferStoreCategory("Botika")).toMatchObject({ categoryId: 3 });
  });

  it("carries the runner-up through so a correction is one glance", async () => {
    mockPredictStore.mockResolvedValue({
      category: "Supermarket & Grocery",
      confidence: 0.62,
      source: "name",
      alternatives: [
        { category: "Fast Food & Restaurant", confidence: 0.3 },
        { category: "Not A Real Category", confidence: 0.05 },
      ],
      reason: "",
    });

    const result: any = await inferStoreCategory("Nanay Linda Store");

    // The unknown alternative is dropped rather than passed on with no id —
    // the console renders these as things the dispatcher can pick.
    expect(result.alternatives).toEqual([
      { categoryId: 5, categoryName: "Fast Food & Restaurant", confidence: 0.3 },
    ]);
  });

  it("refuses to resolve a category this environment does not have", async () => {
    // Renamed, deactivated, or a model trained against a different catalogue.
    // Reported as "no answer" rather than silently dropped, because a guess
    // that keeps naming a category nobody can select is worth noticing.
    mockPredictStore.mockResolvedValue({
      category: "Hardware & Construction",
      confidence: 0.95,
      source: "name",
      alternatives: [],
      reason: "",
    });

    const result: any = await inferStoreCategory("Tacurong Builders");

    expect(result.available).toBe(true);
    expect(result.category).toBeNull();
    expect(result.reason).toContain("not an active category here");
  });

  it("asks only for active categories", async () => {
    mockPredictStore.mockResolvedValue({
      category: "Pharmacy & Health",
      confidence: 0.9,
      source: "name",
      alternatives: [],
      reason: "",
    });

    await inferStoreCategory("Mercury Drug");

    // A deactivated category must never be suggested: the dropdown the
    // dispatcher would correct it with does not contain it.
    expect(mockFindCategories).toHaveBeenCalledWith({ includeInactive: false });
  });
});

describe("saying nothing, in each of the ways it happens", () => {
  it("reports unavailable when no service is configured", async () => {
    mockIsConfigured.mockReturnValue(false);

    const result: any = await inferStoreCategory("Mercury Drug");

    expect(result.available).toBe(false);
    // And it never even asked, so a blank URL costs nothing per pin.
    expect(mockPredictStore).not.toHaveBeenCalled();
  });

  it("reports unavailable when the service cannot be reached", async () => {
    // The client swallows its own failures and answers null; this is the
    // layer that has to turn that into something the console can render.
    mockPredictStore.mockResolvedValue(null);

    expect(await inferStoreCategory("Mercury Drug")).toMatchObject({ available: false });
  });

  it("distinguishes 'we did not ask' from 'we asked and it was not sure'", async () => {
    mockPredictStore.mockResolvedValue({
      category: null,
      confidence: 0.41,
      source: "name",
      alternatives: [],
      reason: "Too close to call.",
    });

    const result: any = await inferStoreCategory("ABC XYZ");

    // available:true with a null category. The console words the two
    // differently, and conflating them would tell a dispatcher the service was
    // broken when it was working and being honest.
    expect(result.available).toBe(true);
    expect(result.category).toBeNull();
    expect(result.confidence).toBe(0.41);
  });
});

describe("items", () => {
  it("keeps results index-aligned with the names that were sent", async () => {
    mockPredictItems.mockResolvedValue([
      { name: "biogesic", category: "Pharmacy & Health", confidence: 0.9, source: "name", alternatives: [], reason: "" },
      { name: "bigas", category: "Supermarket & Grocery", confidence: 0.8, source: "name", alternatives: [], reason: "" },
      { name: "zzz", category: null, confidence: 0.2, source: "name", alternatives: [], reason: "Unsure." },
    ]);

    const results: any[] = await inferItemCategories(["biogesic", "bigas", "zzz"]);

    // Stage 3 zips these back onto its own rows by position, so an order that
    // drifts files a pharmacy item under a grocery.
    expect(results[0].categoryId).toBe(3);
    expect(results[1].categoryId).toBe(4);
    expect(results[2].category).toBeNull();
  });

  it("returns one unavailable per name when the service is down", async () => {
    mockPredictItems.mockResolvedValue(null);

    const results = await inferItemCategories(["biogesic", "bigas"]);

    // Length has to match, or the caller's zip silently drops its last row.
    expect(results).toHaveLength(2);
    expect(results.every((r: any) => r.available === false)).toBe(true);
  });

  it("does not call the service at all when it is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);

    const results = await inferItemCategories(["biogesic", "bigas"]);

    expect(results).toHaveLength(2);
    expect(mockPredictItems).not.toHaveBeenCalled();
  });
});
