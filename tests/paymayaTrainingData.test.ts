import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseTransfer } from "../src/lib/ocr/transferParser.js";
import { validateTransferReceipt } from "../src/services/patterns/transferValidation.js";
import {
  loadCorpus,
  parseSample,
  redatedToToday,
  assertFeeOnlyOnFeeBearingClasses,
  FEE_BEARING_CLASSES,
} from "./helpers/trainingCorpus.js";

/**
 * The Maya corpus in Training_Data_Paymaya, held to its ground truth.
 *
 * These are real confirmations from the wallet customers here actually pay with,
 * and the manifest beside them records what each one must parse to. The point of
 * running them as a test rather than filing them as reference images is that a
 * parser change which quietly stops reading one of these is a customer who
 * cannot pay, and nothing else in the suite would notice: every other sample in
 * tests/ was written from the layouts, and these were written from the screens.
 */

const DIR = "Training_Data_Paymaya";
const corpus = loadCorpus(DIR);

function textFor(file: string): string {
  return readFileSync(`${DIR}/${file}`, "utf8");
}

describe("the Maya training corpus parses to its ground truth", () => {
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
});

describe("where a fee can come from at all", () => {
  // Maya to Maya and Maya to the sender's own Savings are free. Only a transfer
  // out to another e-wallet or a bank goes over InstaPay and is charged. A fee
  // appearing anywhere else means the parser has started reading a figure that
  // is not a fee, and the consequence of that is money.
  it("charges nothing on a transfer that never left Maya", () => {
    expect(() => assertFeeOnlyOnFeeBearingClasses(DIR, corpus)).not.toThrow();
  });

  it("finds a fee on the InstaPay transfer, and only on that one", () => {
    const charged = corpus.filter((s) => (parseSample(DIR, s).transferFee ?? 0) > 0);

    expect(charged.map((s) => s.transferClass)).toEqual(["MAYA_TO_EXTERNAL_INSTAPAY"]);
  });

  it("states the fee outright on an InstaPay receipt rather than leaving it unsaid", () => {
    // A silent fee is the dangerous case: with no printed figure there is no way
    // to tell whether the headline is net or gross, and the two-candidate
    // reading has nothing to work from. If this ever fails it means such a
    // receipt exists, which is worth knowing loudly.
    for (const sample of corpus.filter((s) => FEE_BEARING_CLASSES.has(s.transferClass))) {
      expect(parseSample(DIR, sample).transferFee).not.toBeNull();
    }
  });
});

describe("one transfer photographed from two different Maya screens", () => {
  // "Sent money to" and "Transferred money" are the same ₱25.00 movement. They
  // disagree on the date format and on the casing and spacing of the reference,
  // and a customer has no idea which screen we want. Both must resolve to the
  // same payment or a reupload looks like a second one.
  const sent = parseTransfer(textFor("f88568c0-1abb-48e9-b03a-8695e1683f0b.txt"));
  const transferred = parseTransfer(textFor("0795442b-fb9c-45ae-9b39-af85020accc2.txt"));

  it("resolves 'DBBF 0A06 2BB7' and 'dbbf0a062bb7' to one handle", () => {
    expect(transferred.referenceNo).toBe(sent.referenceNo);
  });

  it("reads the same day from 'Sep 22, 2026' and from '22 Sep 2026'", () => {
    // The day-first shape returned null before this corpus existed, and a
    // receipt with no date is refused outright.
    expect(transferred.transactionDate).not.toBeNull();
    expect(transferred.transactionDate!.getTime()).toBe(sent.transactionDate!.getTime());
  });

  it("reads the same amount from both", () => {
    expect(transferred.amount).toBe(sent.amount);
  });
});

describe("the InstaPay fee is not money we received", () => {
  const instapay = textFor("d327fc6d-1d46-4ba8-a5c0-016096a76147.txt");
  const dated = redatedToToday(instapay, "Sep 17, 2026");

  it("keeps the Maya reference and the InstaPay one apart", () => {
    const parsed = parseTransfer(instapay);
    // "InstaPay Ref. No" contains "ref". Letting the reference scan stop there
    // hands the dispatcher a number that cannot be found in the sender's Maya
    // app, which is the one place they are going to look.
    expect(parsed.referenceNo).toBe("5109881DCD2B");
    expect(parsed.transactionId).toBe("531488");
  });

  it("does not read the recipient's 11-digit account number as an amount", () => {
    expect(parseTransfer(instapay).amount).toBe(108);
  });

  it("settles a ₱98 bill from a ₱108.00 receipt carrying a ₱10.00 fee", () => {
    const result = validateTransferReceipt({ ocrText: dated, dueAmount: 98, dueLabel: "payment" });

    expect(result.amount).toBe(98);
    expect(result.transferFee).toBe(10);
    expect(result.feeExcluded).toBe(true);
  });

  it("still settles a ₱108 bill from the same receipt", () => {
    // Maya prints no total, so the receipt does not say whether its headline
    // already excludes the fee, and both conventions exist. Neither reading may
    // cause a false refusal. (GCash prints the total and so has no ambiguity —
    // see gcashTrainingData.test.ts.)
    const result = validateTransferReceipt({ ocrText: dated, dueAmount: 108, dueLabel: "payment" });

    expect(result.amount).toBe(108);
    expect(result.feeExcluded).toBe(false);
  });

  it("refuses an amount that neither reading can account for", () => {
    // The fee widens acceptance by exactly the fee and no further. ₱50 is not
    // reachable from ₱108.00 by any honest arithmetic.
    expect(() =>
      validateTransferReceipt({ ocrText: dated, dueAmount: 50, dueLabel: "payment" })
    ).toThrow(/is for ₱108\.00/);
  });

  it("quotes the headline the customer can see, not the net, when it refuses", () => {
    // ₱98.00 appears nowhere on their screen. Quoting it reads as a bug.
    expect(() =>
      validateTransferReceipt({ ocrText: dated, dueAmount: 500, dueLabel: "payment" })
    ).toThrow(/₱108\.00/);
  });
});

describe("a zero fee is treated as a fee of zero, not as no fee", () => {
  it("leaves the amount alone when the receipt prints ₱0.00", () => {
    const parsed = parseTransfer(textFor("f88568c0-1abb-48e9-b03a-8695e1683f0b.txt"));

    expect(parsed.transferFee).toBe(0);
    expect(parsed.amount).toBe(25);
  });
});
