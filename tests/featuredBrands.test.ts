import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATURED_STORE_BRANDS,
  featuredBrandOf,
  featuredFirst,
  parseFeaturedBrands,
} from "../src/lib/places/featuredBrands.js";

/** The brands "Find stores" recommends first (2026-10-14). */
describe("featured brands", () => {
  const brands = parseFeaturedBrands("");

  it("defaults to Jollibee, McDonald's, Fitmart, Kimsan, Savemore and 7-Eleven", () => {
    expect(brands.map((b) => b.name)).toEqual(["Jollibee", "McDonald's", "Fitmart", "Kimsan", "Savemore", "7-Eleven"]);
    expect(parseFeaturedBrands(undefined)).toEqual(parseFeaturedBrands(DEFAULT_FEATURED_STORE_BRANDS));
  });

  it("knows each brand by its other names, ignoring case and punctuation", () => {
    expect(featuredBrandOf("7-Eleven Tacurong New Isabela (3453)", brands)).toBe("7-Eleven");
    expect(featuredBrandOf("7/11 Poblacion", brands)).toBe("7-Eleven");
    expect(featuredBrandOf("McDo Tacurong", brands)).toBe("McDonald's");
    expect(featuredBrandOf("McDonald's - Tacurong City", brands)).toBe("McDonald's");
    expect(featuredBrandOf("SAVEMORE MARKET", brands)).toBe("Savemore");
    expect(featuredBrandOf("Save More Tacurong", brands)).toBe("Savemore");
    expect(featuredBrandOf("Kimsan Plaza", brands)).toBe("Kimsan");
    expect(featuredBrandOf("Fitmart Mall", brands)).toBe("Fitmart");
    expect(featuredBrandOf("Jollibee Tacurong Drive-Thru", brands)).toBe("Jollibee");
  });

  it("matches whole words only", () => {
    expect(featuredBrandOf("Save Pharmacy", brands)).toBeNull();
    expect(featuredBrandOf("Kimsanity Store", brands)).toBeNull();
    expect(featuredBrandOf("Mercury Drug", brands)).toBeNull();
    expect(featuredBrandOf("", brands)).toBeNull();
  });

  it("takes the owner's own list from the setting", () => {
    const own = parseFeaturedBrands("Mercury Drug|Mercury; Nena's Store ");
    expect(own.map((b) => b.name)).toEqual(["Mercury Drug", "Nena's Store"]);
    expect(featuredBrandOf("Mercury Tacurong", own)).toBe("Mercury Drug");
    expect(featuredBrandOf("Jollibee", own)).toBeNull();
  });

  it("puts one branch of each brand first, in ranked order, and keeps the rest in place", () => {
    const ranked = ["Corner Store", "7-Eleven A", "Mercury Drug", "Jollibee", "7-Eleven B", "Bakery"];
    const { rows, featured } = featuredFirst(ranked, (name) => name, brands);
    expect(rows).toEqual(["7-Eleven A", "Jollibee", "Corner Store", "Mercury Drug", "7-Eleven B", "Bakery"]);
    expect([...featured]).toEqual(["7-Eleven A", "Jollibee"]);
  });

  it("leaves a list with no featured brand as it was", () => {
    const ranked = ["A", "B", "C"];
    expect(featuredFirst(ranked, (name) => name, brands).rows).toEqual(ranked);
  });
});
