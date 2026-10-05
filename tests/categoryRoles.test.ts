import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { bindRoles, resolveCategoryLabel } from "../src/services/categoryRoles.js";

// The real roles file (server/ml/sugo_category/roles.json), and the same cases
// as server/ml/tests/test_catalogue.py, so the two implementations cannot drift.
const PRODUCTION = [
  { name: "Fast Food & Restaurant", description: "Fast food chains, diners, carinderias, bakeries, and cafes" },
  { name: "Pharmacy & Health", description: "Drugstores, medical supply stores, and clinics" },
  { name: "Supermarket & Grocery", description: "Supermarkets, convenience stores, and public market stalls" },
  { name: "Retail & General Merchandise", description: "Department stores, hardware, school supplies, and dry goods" },
  { name: "Bakery", description: "This is a bakery" },
  { name: "Convenience Store", description: "This is intended for 7/11 etc." },
];

function renamed(from: string, to: string, description?: string) {
  return PRODUCTION.map((c) => (c.name === from ? { name: to, description: description ?? c.description } : c));
}

describe("bindRoles", () => {
  it("binds production's categories by their exact names", () => {
    expect(Object.fromEntries(bindRoles(PRODUCTION))).toEqual({
      food: "Fast Food & Restaurant",
      pharmacy: "Pharmacy & Health",
      grocery: "Supermarket & Grocery",
      retail: "Retail & General Merchandise",
      bakery: "Bakery",
      convenience: "Convenience Store",
    });
  });

  it.each([
    ["Bakery", "Breads & Pastries", "bakery"],
    ["Bakery", "Panaderia", "bakery"],
    ["Fast Food & Restaurant", "Restaurants", "food"],
    ["Pharmacy & Health", "Drugstores", "pharmacy"],
    ["Supermarket & Grocery", "Groceries", "grocery"],
    ["Convenience Store", "Sari-Sari & Minimarts", "convenience"],
  ])("keeps the role when %s is renamed %s", (from, to, role) => {
    const categories = renamed(from, to);
    expect(bindRoles(categories).get(role)).toBe(to);
    expect(resolveCategoryLabel(from, categories)).toBe(to);
  });

  it("binds an opaque new name by its description", () => {
    expect(bindRoles(renamed("Bakery", "Julie's Corner", "This is a bakery")).get("bakery")).toBe("Julie's Corner");
  });

  it("binds nobody on a tie, and the concept falls back to its parent", () => {
    const categories = [...PRODUCTION.filter((c) => c.name !== "Bakery"), { name: "Breads" }, { name: "Cakes" }];
    expect(bindRoles(categories).has("bakery")).toBe(false);
    expect(resolveCategoryLabel("Bakery", categories)).toBe("Fast Food & Restaurant");
  });

  it("resolves a role no category carries to nothing", () => {
    expect(resolveCategoryLabel("Fast Food & Restaurant", [{ name: "Bakery" }, { name: "Pharmacy & Health" }])).toBeNull();
  });

  it("passes live names through untouched", () => {
    expect(resolveCategoryLabel("Convenience Store", PRODUCTION)).toBe("Convenience Store");
    expect(resolveCategoryLabel("Hardware & Construction", [...PRODUCTION, { name: "Hardware & Construction" }])).toBe(
      "Hardware & Construction"
    );
  });
});
