import { describe, expect, it } from "vitest";
import { parseTransfer, isSameDay, calendarDayOf } from "../src/lib/ocr/transferParser.js";

/**
 * Reading a customer's payment confirmation screenshot.
 *
 * The question this parser answers is not "how much?" but "can this specific
 * payment be found again?" — on the company's Facebook Page, or a bank
 * statement. A reference number the dispatcher can look up is the point; an
 * amount with no reference is a screenshot of nothing.
 *
 * Samples below follow the layouts these apps actually print.
 */

const GCASH = `
GCash
Sent via GCash
Amount
PHP 500.00
Ref No. 0123 4567 8901
Sep 05, 2026 1:24 PM
Sugo Express On the Go
`;

const MAYA = `
Maya
Payment Successful
Amount Sent
₱500.00
Reference ID
MYA20260905AB77
Transaction ID
TXN99887766554433
Sep 5, 2026
`;

const BANK = `
BPI Online
Transfer Confirmation
Amount        PHP 1,120.00
Reference Number: 900012345678
Date: 09/05/2026
`;

describe("what the dispatcher needs to look the payment up", () => {
  it("reads a GCash reference, stripping the readability spaces", () => {
    // GCash prints "0123 4567 8901" purely for legibility. A dispatcher pasting
    // this into a search box needs the digits, not the spacing.
    const t = parseTransfer(GCASH);
    expect(t.referenceNo).toBe("012345678901");
  });

  it("reads Maya's reference and transaction id as separate things", () => {
    const t = parseTransfer(MAYA);
    expect(t.referenceNo).toBe("MYA20260905AB77");
    expect(t.transactionId).toBe("TXN99887766554433");
  });

  it("treats a missing transaction id as normal, not a failure", () => {
    // GCash prints only a Ref No. Demanding both would reject the most common
    // screenshot in the country.
    const t = parseTransfer(GCASH);
    expect(t.transactionId).toBeNull();
    expect(t.referenceNo).not.toBeNull();
  });

  it("reads a bank's longer reference number label", () => {
    // "Reference Number" must match before the shorter "reference", which would
    // otherwise capture the wrong side of the label.
    expect(parseTransfer(BANK).referenceNo).toBe("900012345678");
  });

  it("rejects a fragment too short to be a real reference", () => {
    expect(parseTransfer("Ref No. 1234\nAmount PHP 500.00").referenceNo).toBeNull();
  });
});

describe("the amount", () => {
  it("reads a labelled amount", () => {
    expect(parseTransfer(GCASH).amount).toBe(500);
    expect(parseTransfer(MAYA).amount).toBe(500);
  });

  it("handles thousands separators", () => {
    expect(parseTransfer(BANK).amount).toBe(1120);
  });

  it("falls back to the largest peso figure when nothing is labelled", () => {
    // A transfer confirmation has one headline amount, unlike a store receipt
    // where the largest figure is usually cash tendered.
    const t = parseTransfer("Sent\nPHP 500.00\nFee PHP 0.00\nRef No. 111122223333");
    expect(t.amount).toBe(500);
  });
});

describe("the date", () => {
  it("reads a written month, as the e-wallets print it", () => {
    const d = parseTransfer(GCASH).transactionDate!;
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(8); // September
    expect(d.getUTCDate()).toBe(5);
  });

  it("reads a numeric bank date", () => {
    const d = parseTransfer(BANK).transactionDate!;
    expect(d.getUTCMonth()).toBe(8);
    expect(d.getUTCDate()).toBe(5);
  });

  it("reads a day above 12 as the day, whichever side it is on", () => {
    const d = parseTransfer("Date: 22/09/2026\nRef No. 111122223333")!.transactionDate!;
    expect(d.getUTCDate()).toBe(22);
    expect(d.getUTCMonth()).toBe(8);
  });
});

describe("same-day comparison", () => {
  it("matches two moments on one calendar day", () => {
    expect(
      isSameDay(new Date(Date.UTC(2026, 8, 5, 1)), new Date(Date.UTC(2026, 8, 5, 23)))
    ).toBe(true);
  });

  it("separates adjacent days", () => {
    expect(
      isSameDay(new Date(Date.UTC(2026, 8, 5)), new Date(Date.UTC(2026, 8, 6)))
    ).toBe(false);
  });
});

describe("an unreadable screenshot", () => {
  it("returns nulls rather than guesses", () => {
    const t = parseTransfer("blurred\n???");
    expect(t.referenceNo).toBeNull();
    expect(t.amount).toBeNull();
    expect(t.transactionDate).toBeNull();
  });

  it("reports how much text was recognised, for the legibility gate", () => {
    expect(parseTransfer(GCASH).characterCount).toBeGreaterThan(40);
    expect(parseTransfer("??").characterCount).toBeLessThan(40);
  });
});

describe("what counts as today, in Tacurong", () => {
  // A receipt prints a wall-clock date with no timezone, and the parser turns it
  // into UTC midnight of that calendar day. Comparing that against an INSTANT in
  // UTC is wrong for a third of every day here: Tacurong is UTC+8, so between
  // local midnight and 8am the UTC date is still yesterday — and a customer
  // uploading a receipt they had just been sent would be told it "isn't from
  // today". That window is exactly when a late-night errand gets paid for.
  it("reads the LOCAL calendar day, not the UTC one", () => {
    // 00:30 on Sep 5, local. Anywhere east of UTC that instant is still Sep 4 in
    // UTC — which is precisely the bug: the naive comparison called a receipt
    // printed "Sep 05" yesterday's, and refused it.
    const lateNight = new Date(2026, 8, 5, 0, 30);
    const day = calendarDayOf(lateNight);

    expect(day.getUTCFullYear()).toBe(2026);
    expect(day.getUTCMonth()).toBe(8);
    expect(day.getUTCDate()).toBe(5);
  });

  it("accepts a receipt printed on that same local day", () => {
    // The end-to-end shape of the fix: a "Sep 05, 2026" receipt uploaded at
    // half past midnight local is from today, and must be accepted.
    const receiptDay = parseTransfer(`Sep 05, 2026
Ref No. 111122223333`).transactionDate!;
    expect(isSameDay(receiptDay, calendarDayOf(new Date(2026, 8, 5, 0, 30)))).toBe(true);
  });

  it("collapses any time of day to that day's midnight", () => {
    const morning = calendarDayOf(new Date(2026, 8, 5, 1, 0, 0));
    const midnight = calendarDayOf(new Date(2026, 8, 5, 23, 59, 59));
    expect(isSameDay(morning, midnight)).toBe(true);
  });

  it("still separates genuinely different days", () => {
    expect(
      isSameDay(calendarDayOf(new Date(2026, 8, 5, 12)), calendarDayOf(new Date(2026, 8, 6, 12)))
    ).toBe(false);
  });
});
