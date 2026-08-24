import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAmount, parseReceipt } from "../src/lib/ocr/receiptParser.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "receipts");
const read = (name: string) => readFileSync(join(FIXTURES, `${name}.txt`), "utf-8");

// Real OCR output from three Tacurong receipts, captured from Cloud Vision and
// committed so these tests need no network and no API key. Ground truth was read
// off the photographs by eye.
const RECEIPTS = [
  { file: "savemore-primark", store: "SaveMore Primark", total: 994.0, subtotal: 994.0, cash: 1005.0 },
  { file: "seven-eleven", store: "7-Eleven", total: 134.0, subtotal: null, cash: 0.0 },
  { file: "jollibee", store: "Jollibee", total: 176.0, subtotal: 176.0, cash: null },
];

describe("parseAmount", () => {
  it.each([
    ["994.00", 994.0, "plain"],
    ["PHP 176.00", 176.0, "Jollibee prints the currency code on the value"],
    ["1.005.00", 1005.0, "Vision reads a thousands COMMA as a period"],
    ["1,005.00", 1005.0, "and sometimes as a comma"],
    ["55.00V", 55.0, "a VAT marker from the next column, glued on"],
    ["11.00-", 11.0, "trailing sign on a change line"],
    ["  176.00  ", 176.0, "surrounding whitespace"],
  ])("reads %s as %d — %s", (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });

  it("rejects a three-decimal figure rather than rounding it", () => {
    // "1.005" is a stray item price, not ₱1.01 and not ₱1,005. Guessing either
    // way would be worse than declining.
    expect(parseAmount("1.005")).toBeNull();
  });

  it.each(["", "Total", "abc", "--"])("returns null for %s", (raw) => {
    expect(parseAmount(raw)).toBeNull();
  });

  it("never turns a thousands separator into a fractional amount", () => {
    // The failure this guards: parseFloat("1.005.00") === 1.005, a 1000x error
    // on any receipt over ₱999.
    expect(parseAmount("1.005.00")).not.toBeCloseTo(1.005, 3);
  });
});

describe("real Tacurong receipts", () => {
  it.each(RECEIPTS)("reads $store's total as ₱$total", ({ file, total }) => {
    expect(parseReceipt(read(file)).total).toBe(total);
  });

  it.each(RECEIPTS)("reads $store's subtotal and cash separately", ({ file, subtotal, cash }) => {
    const parsed = parseReceipt(read(file));
    expect(parsed.subtotal).toBe(subtotal);
    expect(parsed.cashTendered).toBe(cash);
  });

  it("never returns the cash tendered as the total", () => {
    // SaveMore: ₱1,005 handed over against a ₱994 bill. The largest number on
    // the receipt is the change calculation, not the amount owed.
    const parsed = parseReceipt(read("savemore-primark"));
    expect(parsed.total).toBe(994.0);
    expect(parsed.total).not.toBe(parsed.cashTendered);
  });

  it("does not mistake a subtotal for a total", () => {
    // Jollibee prints "Subtotal PHP 176.00" before "TOTAL DUE". A prefix match on
    // "total" that ignored word boundaries would match "subtotal" first.
    const parsed = parseReceipt(read("jollibee"));
    expect(parsed.total).toBe(176.0);
  });

  it("handles a label with the item count welded on", () => {
    // 7-Eleven prints "Total (3)". An equality check finds nothing at all.
    expect(read("seven-eleven")).toContain("Total (3)");
    expect(parseReceipt(read("seven-eleven")).total).toBe(134.0);
  });

  it("handles a card-paid receipt where cash is zero", () => {
    // Two of the three samples were paid by card. Anything keying off a cash
    // line would read ₱0.00 as the amount spent.
    const parsed = parseReceipt(read("seven-eleven"));
    expect(parsed.cashTendered).toBe(0);
    expect(parsed.total).toBe(134.0);
  });
});

describe("the permit-date trap", () => {
  it.each([
    ["seven-eleven", 2020],
    ["savemore-primark", 2026],
  ])("does not return the Date Issued printed on %s", (file, permitYear) => {
    const text = read(file);
    expect(text.toLowerCase()).toContain("date issued");

    const parsed = parseReceipt(text);
    // 7-Eleven's permit reads 03/01/2020 — six years before the purchase. Taking
    // the labelled date is the obvious move and it is wrong on all three chains.
    if (permitYear === 2020) {
      expect(parsed.transactionDate?.getUTCFullYear()).not.toBe(2020);
    }
    expect(parsed.transactionDate).not.toBeNull();
  });

  it("reads the header date instead", () => {
    // 7-Eleven header: "08/16/2026 (Sun) 19:34:02"
    const parsed = parseReceipt(read("seven-eleven"));
    expect(parsed.transactionDate?.toISOString().slice(0, 10)).toBe("2026-08-16");
  });

  it("handles both date orders, which appear on receipts from the same city", () => {
    // 7-Eleven prints MM/DD/YYYY, SaveMore prints DD/MM/YY ("22/08/26"). A parser
    // fixed to either one silently returns nothing for half the receipts.
    expect(parseReceipt(read("seven-eleven")).transactionDate?.toISOString().slice(0, 10)).toBe("2026-08-16");
    expect(parseReceipt(read("savemore-primark")).transactionDate?.toISOString().slice(0, 10)).toBe("2026-08-22");
  });
});

describe("unreadable input", () => {
  it("returns nulls rather than throwing", () => {
    const parsed = parseReceipt("");
    expect(parsed.total).toBeNull();
    expect(parsed.characterCount).toBe(0);
  });

  it("reports a character count usable as a legibility signal", () => {
    // Drives the clarity verdict: near-zero characters means an unusable photo.
    expect(parseReceipt(read("savemore-primark")).characterCount).toBeGreaterThan(300);
    expect(parseReceipt("  \n \n ").characterCount).toBe(0);
  });
});
