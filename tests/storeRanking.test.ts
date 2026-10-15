import { describe, expect, it } from "vitest";
import {
  affinityScore,
  nameMatchScore,
  proximityScore,
  bestRatedPerGroup,
  MIN_RATINGS_TO_LEAD,
  orderPopular,
  RANKING_WEIGHTS,
  rankByRating,
  rankByRecommendation,
  recencyWeight,
  type RankingInput,
} from "../src/lib/places/storeRanking.js";

/**
 * The Location list's recommendation ranking (2026-10-08): distance heaviest,
 * then the customer's own habits, then everyone's, then the name; for a typed
 * search, name matches first.
 */

type Row = { name: string } & RankingInput;
const row = (name: string, distanceMeters: number | null, extra: Partial<RankingInput> = {}): Row => ({
  name,
  distanceMeters,
  personalOrders: 0,
  popularOrders: 0,
  nameMatch: 0,
  ...extra,
});
const rank = (rows: Row[], searching = false) => rankByRecommendation(rows, (r) => r, searching).map((r) => r.name);

describe("the signals", () => {
  it("weighs distance heaviest, and the weights add up to 1", () => {
    const { proximity, ...others } = RANKING_WEIGHTS;
    expect(Object.values(others).every((w) => w < proximity)).toBe(true);
    expect(proximity + Object.values(others).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("scores the customer's door 1, falling with distance, and an unknown distance 0", () => {
    expect(proximityScore(0)).toBe(1);
    expect(proximityScore(220)).toBeGreaterThan(proximityScore(350));
    expect(proximityScore(700)).toBeCloseTo(0.5, 1);
    expect(proximityScore(null)).toBe(0);
  });

  it("halves an order's weight every half-life", () => {
    expect(recencyWeight(0, 30)).toBe(1);
    expect(recencyWeight(30, 30)).toBeCloseTo(0.5);
    expect(recencyWeight(60, 30)).toBeCloseTo(0.25);
  });

  it("squeezes any number of orders under 1", () => {
    expect(affinityScore(0, 2)).toBe(0);
    expect(affinityScore(2, 2)).toBeGreaterThan(0.6);
    expect(affinityScore(1000, 2)).toBeLessThanOrEqual(1);
  });

  it("rates a name by how directly it answers the search", () => {
    expect(nameMatchScore("Mercury Drug", "mercury drug")).toBe(1);
    expect(nameMatchScore("Mercury Drug", "mercury")).toBe(0.9);
    expect(nameMatchScore("Mercury Drug", "drug")).toBe(0.75);
    expect(nameMatchScore("Watsons", "tson")).toBe(0.6);
    expect(nameMatchScore("Mercury Drug", "mercury pharmacy")).toBeCloseTo(0.2);
    expect(nameMatchScore("Generika", "mercury")).toBe(0.1);
    expect(nameMatchScore("Generika", "")).toBe(0);
  });
});

describe("the order", () => {
  it("is closest first, then second, and so on, when nothing else is known", () => {
    expect(rank([row("C", 900), row("A", 120), row("D", 2100), row("B", 450)])).toEqual(["A", "B", "C", "D"]);
  });

  it("puts a store the customer keeps using ahead of one slightly closer", () => {
    const usual = row("Mercury Drug Alunan", 350, { personalOrders: 3 });
    const closer = row("Mercury Drug Bonifacio", 220);
    expect(rank([closer, usual])).toEqual(["Mercury Drug Alunan", "Mercury Drug Bonifacio"]);
  });

  it("never lets a habit drag a store from across town above one next door", () => {
    expect(rank([row("Usual, far", 3000, { personalOrders: 10 }), row("Next door", 150)])).toEqual([
      "Next door",
      "Usual, far",
    ]);
  });

  it("breaks a near tie in distance with what other customers order", () => {
    expect(rank([row("Quiet", 300), row("Busy", 320, { popularOrders: 8 })])).toEqual(["Busy", "Quiet"]);
  });

  it("lists the stores named like the search before closer ones Google matched another way", () => {
    const named = row("Mercury Drug", 2000, { nameMatch: 0.9 });
    const unnamed = row("Corner Store", 100, { nameMatch: 0.1 });
    expect(rank([unnamed, named], true)).toEqual(["Mercury Drug", "Corner Store"]);
    // With nothing typed there is no name to match, and distance decides.
    expect(rank([unnamed, named], false)).toEqual(["Corner Store", "Mercury Drug"]);
  });

  it("orders many branches of one chain by distance", () => {
    const branches = [2100, 220, 1400, 350].map((d) => row(`Mercury ${d}`, d, { nameMatch: 0.9 }));
    expect(rank(branches, true)).toEqual(["Mercury 220", "Mercury 350", "Mercury 1400", "Mercury 2100"]);
  });

  it("keeps the sources' own order for a true tie", () => {
    expect(rank([row("First", null), row("Second", null)])).toEqual(["First", "Second"]);
  });
});

describe("the popular list", () => {
  const rated = (name: string, rating: number | null, ratingCount: number | null) => ({ name, rating, ratingCount });
  const order = (rows: ReturnType<typeof rated>[]) => rankByRating(rows).map((r) => r.name);

  it("puts the best rated first", () => {
    expect(order([rated("B", 4.2, 80), rated("A", 4.8, 300), rated("C", 3.9, 40)])).toEqual(["A", "B", "C"]);
  });

  it("does not let one 5-star review beat a reputation", () => {
    expect(MIN_RATINGS_TO_LEAD).toBe(5);
    expect(order([rated("Once", 5, 1), rated("Known", 4.6, 210)])).toEqual(["Known", "Once"]);
  });

  it("breaks a tie in stars by how many people rated it", () => {
    expect(order([rated("Few", 4.5, 12), rated("Many", 4.5, 340)])).toEqual(["Many", "Few"]);
  });

  it("lists stores nobody has rated last, in the order Google gave", () => {
    expect(order([rated("Unrated 1", null, null), rated("Rated", 3.1, 9), rated("Unrated 2", null, null)])).toEqual([
      "Rated",
      "Unrated 1",
      "Unrated 2",
    ]);
  });
});

describe("the best of each category", () => {
  const row = (name: string, group: string | null, rating: number | null, ratingCount: number | null) => ({
    name,
    group,
    rating,
    ratingCount,
  });
  const pick = (rows: ReturnType<typeof row>[], limit = 6) => bestRatedPerGroup(rows, (r) => r.group, limit).map((r) => r.name);

  it("takes one per group, its best rated, and orders the winners by rating", () => {
    expect(
      pick([
        row("Cafe B", "food", 4.6, 200),
        row("Cafe A", "food", 4.8, 50),
        row("Drug A", "pharmacy", 4.3, 40),
        row("Mart A", "grocery", 4.5, 90),
      ])
    ).toEqual(["Cafe A", "Mart A", "Drug A"]);
  });

  it("keeps the few-reviews rule inside a group", () => {
    expect(pick([row("Once", "pharmacy", 5, 1), row("Known", "pharmacy", 4.3, 40)])).toEqual(["Known"]);
  });

  it("never lets an unrated or ungrouped row win, and stops at the limit", () => {
    expect(pick([row("Unrated", "retail", null, null), row("Nowhere", null, 4.9, 99)])).toEqual([]);
    expect(pick([row("A", "a", 4.9, 9), row("B", "b", 4.8, 9), row("C", "c", 4.7, 9)], 2)).toEqual(["A", "B"]);
  });
});

describe("the Popular Stores screen's sort settings", () => {
  const row = (name: string, rating: number | null, ratingCount: number | null, distanceMeters: number | null) => ({
    name,
    rating,
    ratingCount,
    distanceMeters,
  });
  // As the server builds the set: the best of each category first, then the rest.
  const set = [
    row("Decent Cup", 4.8, 50, 2400),
    row("Mercury Drug", 4.3, 40, 300),
    row("Savemore", 4.0, 900, 1200),
    row("Nanay's Cafe", 4.6, 200, null),
    row("Once", 5, 1, 150),
  ];
  const order = (sort: Parameters<typeof orderPopular>[1]) => orderPopular(set, sort).map((r) => r.name);

  it("keeps the given order when recommended, without touching the input", () => {
    expect(order("recommended")).toEqual(set.map((r) => r.name));
    expect(orderPopular(set, "recommended")).not.toBe(set);
  });

  it("puts the best rated first, with the few-reviews rule", () => {
    expect(order("rating")).toEqual(["Decent Cup", "Nanay's Cafe", "Mercury Drug", "Savemore", "Once"]);
  });

  it("puts the nearest first and unknown distances last", () => {
    expect(order("distance")).toEqual(["Once", "Mercury Drug", "Savemore", "Decent Cup", "Nanay's Cafe"]);
  });

  it("puts the most reviewed first, then the higher rating, and keeps ties in order", () => {
    expect(order("reviews")).toEqual(["Savemore", "Nanay's Cafe", "Decent Cup", "Mercury Drug", "Once"]);
    const tied = [row("A", 4, 10, null), row("B", 4, 10, null)];
    expect(orderPopular(tied, "reviews").map((r) => r.name)).toEqual(["A", "B"]);
    expect(orderPopular(tied, "distance").map((r) => r.name)).toEqual(["A", "B"]);
  });

  it("is the same set whichever the sort", () => {
    for (const sort of ["recommended", "rating", "distance", "reviews"] as const) {
      expect([...order(sort)].sort()).toEqual([...set.map((r) => r.name)].sort());
    }
  });
});
