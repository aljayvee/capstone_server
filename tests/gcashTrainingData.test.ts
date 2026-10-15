import { describe, expect, it } from "vitest";
import { parseTransfer } from "../src/lib/ocr/transferParser.js";
import { validateTransferReceipt } from "../src/services/patterns/transferValidation.js";
import {
  hasCorpus,
  loadCorpus,
  ocrTextFor,
  parseSample,
  redatedToToday,
  assertFeeOnlyOnFeeBearingClasses,
} from "./helpers/trainingCorpus.js";

/**
 * The GCash corpus in Training_Data_Gcash, held to its ground truth.
 *
 * GCash is the other half of how people here pay, and its receipt is laid out
 * nothing like Maya's: two columns to a line, a principal and a total printed
 * as separate labelled figures, and a promotional block at the bottom that puts
 * stray numbers on the page.
 */

const DIR = "Training_Data_Gcash";
// Gitignored (real receipts), so absent in CI: see hasCorpus. The constructed
// samples further down still run there.
const HAS_CORPUS = hasCorpus(DIR);
const corpus = HAS_CORPUS ? loadCorpus(DIR) : [];

describe.runIf(HAS_CORPUS)("the GCash training corpus parses to its ground truth", () => {
  it.each(corpus.map((s) => [s.screen, s] as const))("%s", (_screen, sample) => {
    const parsed = parseSample(DIR, sample);

    expect(parsed.referenceNo).toBe(sample.expect.referenceNo);
    expect(parsed.transactionId).toBe(sample.expect.transactionId);
    expect(parsed.amount).toBe(sample.expect.amount);
    expect(parsed.transferFee).toBe(sample.expect.transferFee);
    expect(parsed.totalSent).toBe(sample.expect.totalSent);
    expect(parsed.transactionDate?.toISOString().slice(0, 10)).toBe(
      sample.expect.transactionDate
    );
  });

  it("reads every sample legibly enough to clear the blur gate", () => {
    for (const sample of corpus) {
      expect(parseSample(DIR, sample).characterCount).toBeGreaterThan(40);
    }
  });

  it("charges nothing, because GCash to GCash is free", () => {
    // The live payment path. A fee appearing on any of these means the parser
    // has started reading a figure that is not a fee — the carbon block and the
    // recipient's phone number both sit on the page — and the consequence of
    // that is money.
    expect(() => assertFeeOnlyOnFeeBearingClasses(DIR, corpus)).not.toThrow();
  });
});

describe("a reference and a date sharing one line", () => {
  const text = HAS_CORPUS ? ocrTextFor(DIR, corpus[0]) : "";

  it.runIf(HAS_CORPUS)("takes the reference and leaves the timestamp behind", () => {
    // "Ref No. 3045 023 780733    Sep 14, 2026 9:11 AM" is ONE line. Taking
    // everything after the label and stripping punctuation produced
    // "3045023780733SEP142026911AM" — 27 characters, inside every length bound,
    // and not a number that exists anywhere in GCash. Nothing flagged it.
    expect(parseTransfer(text).referenceNo).toBe("3045023780733");
  });

  it.runIf(HAS_CORPUS)("still reads the date off that same line", () => {
    // Shearing the date off the reference must not lose it. It is the only
    // date on the receipt, and a receipt with no date is refused outright.
    const d = parseTransfer(text).transactionDate!;
    expect(d.toISOString().slice(0, 10)).toBe("2026-09-14");
  });

  it("keeps a reference that has no date attached to it", () => {
    // The trim is a rescue, not a rule: when there is no date to cut at, the
    // value must survive untouched.
    expect(parseTransfer("Ref No. 3045 023 780733").referenceNo).toBe("3045023780733");
  });

  it("falls back to the full value when trimming would leave too little", () => {
    // A reference that happens to read like the start of a date must not be
    // truncated into nothing. Better the whole string than an empty one.
    expect(parseTransfer("Ref No. DEC 12 3456").referenceNo).toBe("DEC123456");
  });
});

describe.runIf(HAS_CORPUS)("the promotional block at the bottom of a GCash receipt", () => {
  it("does not mistake the carbon figure for the amount", () => {
    // "279g (gCO2e)" sits below the total, and the amount fallback is "largest
    // peso figure on the page".
    expect(parseTransfer(ocrTextFor(DIR, corpus[0])).amount).toBe(800);
  });

  it("does not mistake the recipient's phone number for money or a reference", () => {
    const parsed = parseTransfer(ocrTextFor(DIR, corpus[0]));
    expect(parsed.amount).toBe(800);
    expect(parsed.referenceNo).toBe("3045023780733");
  });
});

describe("when the receipt states its own arithmetic", () => {
  // GCash prints the principal and the total as two labelled figures. When they
  // differ by the fee, the receipt has said outright that the headline is the
  // principal, and there is nothing left to infer.
  //
  // CONSTRUCTED, not photographed, and deliberately so: customers pay this
  // company GCash-to-GCash, which is free, so no real receipt in the corpus
  // carries a fee and none is expected to. This guards GCash Express Send to a
  // BANK, which does charge and is one tap away in the same app. Without it such
  // a receipt would offer `amount - fee` as a candidate and settle a bill short
  // by the fee. If a real fee-bearing GCash receipt ever arrives, it is the
  // authority — replace this sample with it rather than adjusting it to fit.
  const withFee = `Sent via GCash
Amount 800.00
Service Fee 15.00
Total Amount Sent ₱815.00
Ref No. 3045 023 780733 ${new Date().toDateString()}`;

  it("reads the principal, the fee and the total as three separate figures", () => {
    const parsed = parseTransfer(withFee);
    expect(parsed.amount).toBe(800);
    expect(parsed.transferFee).toBe(15);
    expect(parsed.totalSent).toBe(815);
  });

  it("settles the ₱800 that was sent", () => {
    const result = validateTransferReceipt({
      ocrText: redatedToToday(withFee, new Date().toDateString()),
      dueAmount: 800,
      dueLabel: "payment",
    });
    expect(result.amount).toBe(800);
    expect(result.feeExcluded).toBe(false);
  });

  it("refuses ₱785, because the fee was charged on top and not taken out", () => {
    // Without the total to check against, 800 - 15 would be offered as a
    // candidate and this would wrongly settle. The printed sum closes that.
    expect(() =>
      validateTransferReceipt({
        ocrText: redatedToToday(withFee, new Date().toDateString()),
        dueAmount: 785,
        dueLabel: "payment",
      })
    ).toThrow(/is for ₱800\.00/);
  });

  it("refuses ₱815, the total the sender was debited", () => {
    // The fee went to the rails. Billing it to the customer would overcharge
    // them by the fee on every transfer.
    expect(() =>
      validateTransferReceipt({
        ocrText: redatedToToday(withFee, new Date().toDateString()),
        dueAmount: 815,
        dueLabel: "payment",
      })
    ).toThrow(/is for ₱800\.00/);
  });
});
