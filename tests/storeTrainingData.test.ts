import { describe, expect, it } from "vitest";
import { parseReceipt } from "../src/lib/ocr/receiptParser.js";
import { existsSync } from "node:fs";
import {
  loadStoreCorpus,
  loadExclusions,
  storeTextFor,
  parseStoreSample,
  assertNeverThePermitDate,
  type StoreSample,
} from "./helpers/trainingCorpus.js";

/**
 * The store receipt corpora, held to their ground truth.
 *
 * Training_Data_Jollibee and Training_Data_7_Eleven are the two chains riders
 * actually shop at, and this is the figure the customer is billed from. An error
 * here is not a failed upload, it is a wrong amount of money.
 */

const CORPORA: [string, string][] = [
  ["Jollibee", "Training_Data_Jollibee"],
  ["7-Eleven", "Training_Data_7_Eleven"],
];

describe.each(CORPORA)("the %s training corpus parses to its ground truth", (_chain, DIR) => {
  const corpus = loadStoreCorpus(DIR);

  it.each(corpus.map((s) => [s.receipt, s] as const))("%s", (_receipt, sample: StoreSample) => {
    const parsed = parseStoreSample(DIR, sample);

    expect(parsed.total).toBe(sample.expect.total);
    expect(parsed.subtotal).toBe(sample.expect.subtotal);
    expect(parsed.cashTendered).toBe(sample.expect.cashTendered);
    expect(parsed.transactionDate?.toISOString().slice(0, 10)).toBe(
      sample.expect.transactionDate
    );
  });

  it("never returns the BIR permit date as the purchase date", () => {
    expect(() => assertNeverThePermitDate(DIR, corpus)).not.toThrow();
  });

  it("never returns the cash tendered as the total", () => {
    // The largest figure on a cash receipt is what was handed over, not what was
    // owed. ₱1,000 against a ₱644 bill on the Jollibee sample.
    for (const sample of corpus) {
      const parsed = parseStoreSample(DIR, sample);
      if (parsed.cashTendered !== null && parsed.cashTendered > 0) {
        expect(parsed.total).not.toBe(parsed.cashTendered);
      }
    }
  });

  it("reads every sample legibly enough to clear the blur gate", () => {
    for (const sample of corpus) {
      expect(parseStoreSample(DIR, sample).characterCount).toBeGreaterThan(40);
    }
  });

  it("agrees with the amount a person read off the photograph", () => {
    // The check that actually matters. Every other assertion compares the parser
    // against a manifest someone wrote; this compares it against what the
    // operator read off the paper, which is the number the customer is billed.
    for (const sample of corpus) {
      expect(parseStoreSample(DIR, sample).total).toBe(sample.humanRead.amount);
    }
  });

  it("carries no ground truth for an image the operator excluded", () => {
    // A receipt nobody can read must not have a .txt beside it. A transcription
    // of an illegible receipt is a guess wearing the clothes of a fact, and it
    // would be asserted by every test above as though it were known.
    for (const excluded of loadExclusions(DIR)) {
      const txt = `${DIR}/${excluded.image.replace(/\.jpg$/, ".txt")}`;
      expect(existsSync(txt), `${txt} should not exist: ${excluded.reason}`).toBe(false);
      expect(corpus.map((s) => s.image)).not.toContain(excluded.image);
      expect(excluded.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("the item count welded to a 7-Eleven total label", () => {
  // The worst bug this whole corpus turned up, and the reason store receipts
  // needed their own training data.
  //
  // 7-Eleven prints "Total (10)" and "330.00" as two COLUMNS of one printed row.
  // Vision splits that pair onto separate lines on the samples captured so far,
  // which is why it went unnoticed — but Vision demonstrably does NOT always
  // split columns: on the Jollibee receipt beside it, "Subtotal PHP 176.00"
  // comes back as a single line. When the count and the amount land together,
  // parseAmount's strip-everything-then-match turned "(10) 330.00" into
  // "10330.00".
  //
  // A ₱330 receipt read as ₱10,330, on the figure the customer is billed from.
  it.each([
    ["Total (1) 99.00", 99],
    ["Total (3) 134.00", 134],
    ["Total (10) 330.00", 330],
    ["Total (10)330.00", 330],
  ])("reads %s as ₱%d", (line, expected) => {
    expect(parseReceipt(`${line}\nCASH\n500.00`).total).toBe(expected);
  });

  it("still reads the split layout Vision actually produced", () => {
    // The fix must not cost the layout that was already working.
    expect(parseReceipt("Total (3)\n134.00\nCASH\n0.00").total).toBe(134);
  });

  it("still reads a currency code sharing the line", () => {
    // Jollibee's same-line shape, which relies on the same code path.
    expect(parseReceipt("TOTAL DUE PHP 315.00").total).toBe(315);
    expect(parseReceipt("Subtotal PHP 176.00").subtotal).toBe(176);
  });

  it("still reads a thousands separator Vision rendered as a period", () => {
    // parseAmount's strictness is load-bearing; reading tokens right-to-left
    // must not loosen it. "1.005.00" is ₱1,005 and must stay that way.
    expect(parseReceipt("Total\n1.005.00").total).toBe(1005);
  });
});

describe("a 7-Eleven e-load receipt, which is mostly hotline numbers", () => {
  const DIR = "Training_Data_7_Eleven";
  const sample = loadStoreCorpus(DIR).find((s) => s.image.startsWith("711_IMG4"))!;
  const text = storeTextFor(DIR, sample);

  it("finds the header date and not an ECPAY hotline", () => {
    // "0919-08-32729", "(02)7613-5951", "0917-72-32729" all sit ABOVE the totals
    // block. A looser date pattern reaches one of them first.
    expect(text).toContain("0919-08-ECPAY");
    expect(parseReceipt(text).transactionDate?.toISOString().slice(0, 10)).toBe("2026-08-24");
  });

  it("reads the top-up amount rather than the cash handed over", () => {
    expect(parseReceipt(text).total).toBe(99);
    expect(parseReceipt(text).cashTendered).toBe(100);
  });
});

describe("a card receipt that prints CASH 0.00", () => {
  it("distinguishes a printed zero from no cash line at all", () => {
    // 7-Eleven prints "CASH 0.00" on a card sale; Jollibee omits the line
    // entirely. Both are card sales and neither cost nothing, but the parsed
    // values differ because the receipts differ, and flattening them would hide
    // which receipt was actually read.
    const sevenEleven = loadStoreCorpus("Training_Data_7_Eleven").find((s) =>
      s.image.startsWith("711_IMG2")
    )!;
    const jollibee = loadStoreCorpus("Training_Data_Jollibee").find((s) =>
      s.image.startsWith("JB_IMG1")
    )!;

    expect(parseStoreSample("Training_Data_7_Eleven", sevenEleven).cashTendered).toBe(0);
    expect(parseStoreSample("Training_Data_Jollibee", jollibee).cashTendered).toBeNull();

    expect(parseStoreSample("Training_Data_7_Eleven", sevenEleven).total).toBe(40);
    expect(parseStoreSample("Training_Data_Jollibee", jollibee).total).toBe(184);
  });
});
