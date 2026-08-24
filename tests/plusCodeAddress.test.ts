import { describe, expect, it } from "vitest";

// The predicate under test is duplicated in two places that cannot import each
// other — the customer app's useReverseGeocodedAddress.ts and this server's
// scripts/backfillPlusCodeAddresses.ts. Both must agree, or the backfill will
// skip rows the app would now reject (or rewrite ones it would have kept), so
// the shared shape is pinned here.
const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}$/i;

function isPlusCodeAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  return PLUS_CODE.test(address.split(",")[0].trim());
}

describe("plus-code address detection", () => {
  it("catches the address from the reported defect", () => {
    // A pin on the STI College campus, saved verbatim from Android's geocoder.
    expect(
      isPlusCodeAddress("MMM8+F22, Road, City of Tacurong, Sultan Kudarat, Philippines")
    ).toBe(true);
  });

  it.each([
    "MMM8+F22",
    "7Q63+9M, Tacurong",
    "mmm8+f22, Road, City of Tacurong",
    "6PH59R2C+CV",
  ])("catches %s", (address) => {
    expect(isPlusCodeAddress(address)).toBe(true);
  });

  it.each([
    "Jollibee Tacurong Center (Main)",
    "National Highway, Tacurong City",
    "Purok Malipayon, Barangay New Isabela",
    "STI College Tacurong",
    "Block 5 Lot 12, Tacurong",
  ])("leaves the real address %s alone", (address) => {
    expect(isPlusCodeAddress(address)).toBe(false);
  });

  it("does not fire on an address that merely contains a plus sign", () => {
    // The grid alphabet excludes vowels, so ordinary words cannot match — but a
    // '+' in a street name must not be enough on its own.
    expect(isPlusCodeAddress("Shell + Go Station, Tacurong")).toBe(false);
  });

  it("only tests the leading segment", () => {
    // A later segment that happens to look like a code is not the geocoder
    // emitting a plus code; the code is always the first component.
    expect(isPlusCodeAddress("Rizal Street, MMM8+F22")).toBe(false);
  });

  it.each([null, undefined, "", "   "])("treats %s as not a plus code", (address) => {
    expect(isPlusCodeAddress(address)).toBe(false);
  });
});
