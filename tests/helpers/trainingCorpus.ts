import { readFileSync } from "node:fs";
import { parseTransfer, type ParsedTransfer } from "../../src/lib/ocr/transferParser.js";
import { parseReceipt, type ParsedReceipt } from "../../src/lib/ocr/receiptParser.js";

/**
 * Loader for the wallet training corpora — Training_Data_Paymaya and
 * Training_Data_Gcash.
 *
 * Both hold the same three things: a screenshot, the text Cloud Vision
 * recognises from it, and a manifest saying what that text must parse to. The
 * loader is shared so a new corpus is a folder and a manifest rather than a
 * folder, a manifest and a copy of the assertions.
 */

/**
 * The classes of transfer the corpora hold, and which of them can be charged.
 *
 * A fee is not a property of an app, it is a property of where the money went.
 * Maya to Maya and Maya to the sender's own Savings are free; Maya out to
 * another e-wallet or a bank goes over InstaPay and is charged. GCash to GCash,
 * the live payment path, is free.
 *
 * Worth stating as data rather than prose because it is the one thing that keeps
 * the fee rule honest: if a free transfer ever parses with a fee on it, either
 * the sample is mislabelled or the parser has started reading a figure that is
 * not a fee, and both are bugs that would otherwise surface as money.
 */
export const FEE_BEARING_CLASSES = new Set(["MAYA_TO_EXTERNAL_INSTAPAY"]);

export interface TrainingSample {
  image: string;
  screen: string;
  teaches: string;
  /** Where the money went. See FEE_BEARING_CLASSES. */
  transferClass: string;
  expect: {
    referenceNo: string | null;
    transactionId: string | null;
    amount: number;
    transferFee: number | null;
    totalSent: number | null;
    transactionDate: string;
  };
}

export function loadCorpus(dir: string): TrainingSample[] {
  const manifest: { samples: TrainingSample[] } = JSON.parse(
    readFileSync(`${dir}/manifest.json`, "utf8")
  );
  return manifest.samples;
}

/**
 * The fee invariant, shared by both corpora.
 *
 * Only a transfer that actually left the wallet's own network may carry a
 * charge. Run against the PARSED receipt rather than the manifest, so it catches
 * a parser that has started finding a fee where the receipt prints none — a
 * promotional figure, a masked balance — as well as a mislabelled sample.
 */
export function assertFeeOnlyOnFeeBearingClasses(dir: string, corpus: TrainingSample[]): void {
  for (const sample of corpus) {
    const fee = parseSample(dir, sample).transferFee;
    if (fee !== null && fee > 0 && !FEE_BEARING_CLASSES.has(sample.transferClass)) {
      throw new Error(
        `${sample.image} is ${sample.transferClass}, which is free, but parsed a fee of ${fee}.`
      );
    }
  }
}

export function ocrTextFor(dir: string, sample: TrainingSample): string {
  return readFileSync(`${dir}/${sample.image.replace(/\.jpg$/, ".txt")}`, "utf8");
}

export function parseSample(dir: string, sample: TrainingSample): ParsedTransfer {
  return parseTransfer(ocrTextFor(dir, sample));
}

/**
 * Re-date a sample's text to today.
 *
 * The corpus is fixed in time and the same-day gate is not, so anything that
 * exercises validateTransferReceipt has to move the printed date forward. Only
 * the date is touched; every other character is the receipt as it was read.
 */
export function redatedToToday(text: string, printed: string): string {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = new Date();
  return text.replace(printed, `${M[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`);
}

/**
 * The STORE receipt corpora — Training_Data_Jollibee and Training_Data_7_Eleven.
 *
 * A different job from the wallet corpora above, and a different parser. A
 * transfer confirmation is a crisp screenshot and the question is "can this
 * payment be found again?"; these are thermal paper photographed on a bed at
 * night, and the question is "what was the total?". Same manifest shape, so the
 * two kinds of corpus are maintained the same way.
 */
export interface StoreSample {
  image: string;
  receipt: string;
  teaches: string;
  /**
   * The operator's own reading of the photograph, and the authority for what the
   * receipt SAYS.
   *
   * Kept apart from `expect`, which is what the parser must RETURN, because the
   * two are different claims. On 711_IMG2 they disagree about cash and both are
   * right: 40 pesos were tendered, none of it cash, and `cashTendered` reads the
   * CASH line. A divergence is explained on the sample, never averaged away.
   */
  humanRead: {
    amount: number;
    subtotal?: number;
    cash?: number;
    change?: number;
    paymentType?: string;
    serviceType?: string;
  };
  /**
   * Where the .txt came from.
   *
   * VISION_CAPTURED text is real Cloud Vision output, character-level noise and
   * all. TRANSCRIBED text was read off the photograph by eye and written in
   * Vision's observed line convention. The distinction matters: a transcription
   * proves the parser handles the receipt's STRUCTURE, not that it survives
   * whatever Vision actually makes of a creased thermal print.
   */
  textSource: "VISION_CAPTURED" | "TRANSCRIBED";
  /** The independent arithmetic on the receipt that confirms `expect`. */
  checksum: string;
  expect: {
    total: number | null;
    subtotal: number | null;
    cashTendered: number | null;
    transactionDate: string;
  };
}

export interface ExcludedSample {
  image: string;
  reason: string;
  decidedBy: string;
  note: string;
}

export function loadStoreCorpus(dir: string): StoreSample[] {
  const manifest: { samples: StoreSample[] } = JSON.parse(
    readFileSync(`${dir}/manifest.json`, "utf8")
  );
  return manifest.samples;
}

/**
 * Images the operator has ruled out, with the reason.
 *
 * An excluded sample keeps its .jpg and has no .txt and no ground truth. That is
 * the whole point: a receipt no human can read must not carry a confident
 * transcription, because the transcription would be someone's guess wearing the
 * clothes of a fact.
 */
export function loadExclusions(dir: string): ExcludedSample[] {
  const manifest: { excluded?: ExcludedSample[] } = JSON.parse(
    readFileSync(`${dir}/manifest.json`, "utf8")
  );
  return manifest.excluded ?? [];
}

export function storeTextFor(dir: string, sample: StoreSample): string {
  return readFileSync(`${dir}/${sample.image.replace(/\.jpg$/, ".txt")}`, "utf8");
}

export function parseStoreSample(dir: string, sample: StoreSample): ParsedReceipt {
  return parseReceipt(storeTextFor(dir, sample));
}

/**
 * The permit-date trap, as an invariant over a whole corpus.
 *
 * Every Philippine POS receipt carries a BIR permit date at its foot, and on
 * these chains it is years older than the purchase — 7-Eleven prints
 * "Date Issued: 08/01/2020". Taking the labelled date is the obvious move and it
 * is wrong on every sample here. Asserted corpus-wide rather than per-receipt
 * because it is the single mistake most likely to be reintroduced.
 */
export function assertNeverThePermitDate(dir: string, corpus: StoreSample[]): void {
  for (const sample of corpus) {
    const text = storeTextFor(dir, sample);
    const parsed = parseStoreSample(dir, sample);

    const permit = text.match(/date issued:?\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/i);
    if (!permit) continue;

    const iso = parsed.transactionDate?.toISOString().slice(0, 10);
    if (iso === undefined) {
      throw new Error(`${sample.image} parsed no date at all.`);
    }
    if (iso.startsWith(permit[3])) {
      throw new Error(`${sample.image} returned the permit year ${permit[3]} as the purchase date.`);
    }
  }
}
