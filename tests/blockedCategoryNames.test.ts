import { describe, expect, it } from "vitest";
import {
  findBlockedCategoryTerm,
  normaliseCategoryName,
  RETIRED_CATEGORY_NAMES,
} from "../src/lib/blockedCategoryNames.js";

const blocked = (name: string) => findBlockedCategoryTerm(name) !== null;

describe("blocked category names", () => {
  it.each([
    "Bills & Payment Centers",
    "bills and payment centers",
    "Pay Bills",
    "Bills",
    "Utility Payments",
    "Remittance Center",
  ])("blocks the English name %s", (name) => {
    expect(blocked(name)).toBe(true);
  });

  it.each([
    "Bayad Center",
    "BAYAD-CENTER",
    "Tacurong Bayad Centre",
    "Bayarin",
    "Pera Padala",
    "Padala",
    "Singil",
  ])("blocks the Filipino name %s", (name) => {
    // The one that matters most in practice: "Bayad Center" is the ordinary
    // Philippine name for these outlets, far likelier to be typed than the
    // English. Blocking only English would have been close to useless here.
    expect(blocked(name)).toBe(true);
  });

  it.each(["Bayranan", "Bayaranan", "Sukot", "Singir", "Bayadan"])(
    "blocks the regional name %s",
    (name) => {
      expect(blocked(name)).toBe(true);
    }
  );

  it.each([
    ["  bayad   center  ", "extra whitespace"],
    ["Bayad & Payment", "ampersand folding"],
    ["Bayad_Center!!", "punctuation"],
    ["BaYaD cEnTeR", "mixed case"],
  ])("normalises %s (%s)", (name) => {
    expect(blocked(name)).toBe(true);
  });

  it("names the term it matched", () => {
    // Over-blocking is the worse failure of the two, so an owner who trips this
    // has to be able to see which word did it.
    const match = findBlockedCategoryTerm("Tacurong Bayad Center");
    expect(match).not.toBeNull();
    expect(match!.term).toBe("bayad center");
    expect(match!.language).toBeTruthy();
  });
});

describe("names that must NOT be blocked", () => {
  it.each([
    ["Water Refilling Station", "bare tubig/water is a real Pabili stop"],
    ["Tubig Delivery", "same — only 'bayad tubig' is a bill"],
    ["Bayambang Sari-Sari Store", "contains 'baya' but not the token 'bayad'"],
    ["Payong & Umbrella Supply", "contains 'payo', not a payment term"],
    ["Billiards Hall", "contains 'bill' as a substring, not as a word"],
  ])("allows %s — %s", (name) => {
    expect(blocked(name)).toBe(false);
  });

  it.each([
    "Fast Food & Restaurant",
    "Pharmacy & Health",
    "Supermarket & Grocery",
    "Retail & General Merchandise",
  ])("never blocks the seeded default %s", (name) => {
    // If this ever fails, a re-seed cannot run.
    expect(blocked(name)).toBe(false);
  });
});

describe("retired list", () => {
  it("covers every name the seeder deactivates", () => {
    // The retired set and the blocked set must not drift: a name worth retiring
    // is a name worth refusing to re-create.
    for (const name of RETIRED_CATEGORY_NAMES) {
      if (name === "test1") continue; // leftover test data, not a bills term
      expect(blocked(name)).toBe(true);
    }
  });
});

describe("normaliseCategoryName", () => {
  it("reduces punctuation, case and spacing to one comparable form", () => {
    expect(normaliseCategoryName("  Bayad-Center!  ")).toBe("bayad center");
    expect(normaliseCategoryName("Food & Drink")).toBe("food and drink");
  });
});
