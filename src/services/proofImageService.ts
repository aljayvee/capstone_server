import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { readText, configuredEngines } from "../lib/ocr/resilientOcrService.js";
import { parseReceipt } from "../lib/ocr/receiptParser.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { ServiceError } from "./ServiceError.js";
import * as errandService from "./errandService.js";
import type { ProofImageUploadInput } from "../validators/proofImageValidators.js";

/**
 * Below this many recognised characters, the photo is unusable rather than the
 * receipt being unusual. Measured against the three real fixtures, which return
 * 794-1014 characters; a blurred or mis-aimed shot returns single digits.
 */
const MIN_LEGIBLE_CHARACTERS = 40;

/**
 * How far a rider's confirmed total may drift from the OCR reading before
 * dispatch is told. Whichever is greater, so a ₱50 correction on a ₱120 fast-food
 * receipt does not alert while the same ₱50 on a ₱5,000 grocery run does not
 * either — only a genuinely large gap does.
 *
 * Small corrections are routine: OCR misreads a digit on creased paper and the
 * rider fixes it. Alerting on those trains dispatch to ignore the alert.
 */
const DIVERGENCE_ABSOLUTE = 100;
const DIVERGENCE_FRACTION = 0.2;

function stripDataUri(imageData: string): string {
  return imageData.replace(/^data:image\/[a-z]+;base64,/, "");
}

async function assertRidersOwnErrand(errandId: string, riderId: number) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");
  if (errand.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: you can only add proof to errands assigned to you.");
  }
  return errand;
}

/**
 * Stores a photograph and reads it.
 *
 * RECEIPT images go to Cloud Vision here on the server — crumpled thermal paper
 * is the hard case and the one Vision was chosen for. TRANSFER images arrive with
 * text the device already extracted using ML Kit: a GCash screenshot is crisp
 * machine-rendered text that on-device OCR handles perfectly, for free, offline,
 * and without the image leaving the phone.
 *
 * Throws rather than storing a useless row when nothing legible came back. The
 * rider is required to produce a readable receipt before continuing, so failing
 * loudly here is the point — but the message has to say what to DO about it.
 */
export async function uploadProofImage(
  errandId: string,
  riderId: number,
  input: ProofImageUploadInput
) {
  await assertRidersOwnErrand(errandId, riderId);

  const base64 = stripDataUri(input.imageData);

  // Read first, store second. A photo that cannot be read is not evidence, and
  // keeping it would leave rows nothing can ever act on.
  const isTransfer = input.kind === "TRANSFER";
  const ocr = isTransfer
    ? input.deviceText
      ? { text: input.deviceText, engine: "MLKIT" as const, confidence: null }
      : null
    : await readText(base64);

  if (!ocr) {
    // Two very different failures wearing the same shape. A rider who can retake
    // the photo needs to hear something different from one whose service is down.
    const engineAvailable = isTransfer || configuredEngines().length > 0;
    throw new ServiceError(
      engineAvailable ? 422 : 503,
      engineAvailable
        ? "We couldn't read that photo. Move to better light, hold the phone steady and make sure the whole receipt is in frame, then try again."
        : "Receipt scanning is unavailable right now. Please try again in a moment — your errand is not lost."
    );
  }

  const parsed = parseReceipt(ocr.text);

  if (parsed.characterCount < MIN_LEGIBLE_CHARACTERS) {
    throw new ServiceError(
      422,
      "That photo came out too blurry to read. Hold steady, get closer, and make sure the receipt is flat."
    );
  }

  // A sharp photo of a folded receipt reads plenty of text and still yields no
  // total. Stored rather than rejected: the rider can enter the figure and the
  // image is still evidence, but the extraction is flagged for review.
  const status = parsed.total === null ? "NEEDS_REVIEW" : "OK";
  const clarityVerdict = parsed.characterCount > 300 ? "SHARP" : "ACCEPTABLE";

  const image = await prisma.errandProofImage.create({
    data: {
      errandId,
      riderId,
      pinpointId: input.pinpointId ?? null,
      kind: input.kind,
      imageData: base64,
      mimeType: input.mimeType,
      byteSize: input.fileSize,
      clarityScore: parsed.characterCount,
      clarityVerdict,
      extraction: {
        create: {
          engine: ocr.engine,
          rawText: ocr.text,
          extractedTotal: parsed.total,
          extractedDate: parsed.transactionDate,
          confidence: ocr.confidence,
          status,
        },
      },
    },
    include: { extraction: true },
  });

  logger.info(
    `Errand ${errandId}: ${input.kind} read by ${ocr.engine} — ` +
      `${parsed.characterCount} chars, total ${parsed.total ?? "not found"}.`
  );

  return image;
}

/**
 * The rider accepts the extracted figure, or corrects it.
 *
 * OCR proposes and the rider disposes. Both numbers are kept: a misread digit
 * must never silently become the amount a customer is charged, and a rider who
 * routinely overrides is something the stored pair makes visible.
 */
export async function confirmProofImage(
  errandId: string,
  imageId: number,
  riderId: number,
  confirmedTotal: number
) {
  await assertRidersOwnErrand(errandId, riderId);

  const image = await prisma.errandProofImage.findUnique({
    where: { id: imageId },
    include: { extraction: true },
  });
  if (!image || image.errandId !== errandId) {
    throw new ServiceError(404, "That photo does not belong to this errand.");
  }
  if (!image.extraction) {
    throw new ServiceError(409, "That photo has no reading to confirm.");
  }

  const extraction = await prisma.receiptExtraction.update({
    where: { id: image.extraction.id },
    data: { confirmedTotal, confirmedAt: new Date(), status: "OK" },
  });

  const extracted = extraction.extractedTotal;
  if (extracted !== null) {
    const gap = Math.abs(confirmedTotal - extracted);
    const threshold = Math.max(DIVERGENCE_ABSOLUTE, extracted * DIVERGENCE_FRACTION);

    if (gap > threshold) {
      logger.info(
        `Errand ${errandId}: rider ${riderId} confirmed ${confirmedTotal} against an OCR reading of ${extracted} (gap ${gap.toFixed(2)}).`
      );
      eventPublisher.emitToErrand(errandId, "errand:receipt_mismatch", {
        errandId,
        imageId,
        riderId,
        extractedTotal: extracted,
        confirmedTotal,
        gap: Math.round(gap * 100) / 100,
      });
    }
  }

  // A confirmed receipt total is the real cost of the goods, so it reprices the
  // errand through the existing path rather than a parallel one.
  //
  // The figure sent is the sum of EVERY confirmed receipt on this errand, not
  // just the one being confirmed now. markItemsPurchased assigns
  // `estimatedCost = receiptTotal` outright, so on a two-store run the second
  // receipt would otherwise overwrite the first — a rider who spent 176 at
  // Jollibee and 994 at SaveMore would bill the customer for 994 of goods and
  // the business would silently absorb the difference.
  //
  // Summing rather than adding also makes re-confirmation safe: correcting a
  // total recomputes the whole basket instead of double-counting it.
  if (image.kind === "RECEIPT") {
    await errandService.markItemsPurchased(errandId, riderId, await confirmedReceiptTotal(errandId));
  }

  return extraction;
}

/**
 * What the rider has confirmed spending on goods for this errand so far.
 *
 * Only confirmed figures count. An extraction the rider has not yet accepted is
 * a machine's guess, and a guess must never reach a customer's bill.
 */
async function confirmedReceiptTotal(errandId: string): Promise<number> {
  const receipts = await prisma.errandProofImage.findMany({
    where: { errandId, kind: "RECEIPT" },
    select: { extraction: { select: { confirmedTotal: true } } },
  });

  const total = receipts.reduce((sum, r) => sum + (r.extraction?.confirmedTotal ?? 0), 0);
  return Math.round(total * 100) / 100;
}

export function listProofImages(errandId: string) {
  return prisma.errandProofImage.findMany({
    where: { errandId },
    // The blob is deliberately omitted: a list of five receipts would otherwise
    // be two megabytes of base64 nobody asked for. Fetch one by id to see it.
    select: {
      id: true,
      kind: true,
      pinpointId: true,
      mimeType: true,
      byteSize: true,
      clarityVerdict: true,
      capturedAt: true,
      extraction: {
        select: { extractedTotal: true, confirmedTotal: true, status: true, engine: true },
      },
    },
    orderBy: { capturedAt: "asc" },
  });
}
