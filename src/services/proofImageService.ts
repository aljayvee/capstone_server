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
export const DIVERGENCE_ABSOLUTE = 100;
export const DIVERGENCE_FRACTION = 0.2;

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

  // A shop that prints nothing.
  //
  // The photo is of the GOODS, so there is no text in it by definition — running
  // it through OCR would spend a paid call to learn that, and the legibility
  // floor below would then reject a perfectly sharp picture as "too blurry to
  // read". That is exactly what stranded riders at sari-sari stores: a gate
  // demanding a receipt that was never going to exist, and an error message
  // blaming them for it.
  //
  // The rider's figure is the only one available, so it is stored as an
  // assertion — verified false — rather than dressed up as a reading.
  if (input.kind === "NO_RECEIPT") {
    if (!input.declaredTotal || input.declaredTotal <= 0) {
      throw new ServiceError(400, "Enter what you paid at this shop.");
    }

    const declared = await prisma.errandProofImage.create({
      data: {
        errandId,
        riderId,
        pinpointId: input.pinpointId ?? null,
        kind: "NO_RECEIPT",
        imageData: base64,
        mimeType: input.mimeType,
        byteSize: input.fileSize,
        verified: false,
        declaredTotal: input.declaredTotal,
      },
    });

    logger.info(
      `Errand ${errandId}: rider ${riderId} declared ${input.declaredTotal} at a shop with no receipt.`
    );

    // Dispatch is told while it is happening, not found in a report later.
    eventPublisher.emitToErrand(errandId, "errand:unverified_purchase", {
      errandId,
      imageId: declared.id,
      riderId,
      declaredTotal: input.declaredTotal,
      pinpointId: input.pinpointId ?? null,
    });

    // A declared purchase counts toward the basket the same as a read one.
    await errandService.markItemsPurchased(errandId, riderId, await confirmedReceiptTotal(errandId));

    // `extraction: null` rather than absent, so every caller sees one shape
    // whatever kind was uploaded.
    return { ...declared, clarityVerdict: null, extraction: null };
  }

  // A doorstep photo has nothing to read either, and no amount attached to it.
  if (input.kind === "PROOF_OF_DELIVERY") {
    const handover = await prisma.errandProofImage.create({
      data: {
        errandId,
        riderId,
        pinpointId: null,
        kind: "PROOF_OF_DELIVERY",
        imageData: base64,
        mimeType: input.mimeType,
        byteSize: input.fileSize,
      },
    });
    return { ...handover, clarityVerdict: null, extraction: null };
  }

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
  const purchases = await prisma.errandProofImage.findMany({
    where: { errandId, kind: { in: ["RECEIPT", "NO_RECEIPT"] } },
    select: { declaredTotal: true, extraction: { select: { confirmedTotal: true } } },
  });

  // A declared amount from a receiptless shop spends the same money as a read
  // one, so it joins the basket the same way. Whether it can be corroborated is
  // recorded on the row, not by leaving it out of the total the customer pays.
  const total = purchases.reduce(
    (sum, p) => sum + (p.extraction?.confirmedTotal ?? p.declaredTotal ?? 0),
    0
  );
  return Math.round(total * 100) / 100;
}

/**
 * Who may look at an errand's evidence.
 *
 * This check did not exist: listProofImages was authenticated and nothing more,
 * so any signed-in account could enumerate the proof metadata for any errand by
 * id — another customer's receipts, totals and capture times. The route comment
 * justified open reads because dispatch and the owner need the evidence during a
 * dispute, which is an argument for STAFF, not for everyone.
 *
 * Mirrors the object-level rule getErrandById already applies. The dispatcher
 * claim restriction there is deliberately not repeated: it governs who may work
 * an errand in the queue, and evidence has to stay readable by whoever ends up
 * investigating it.
 */
export async function assertMayViewProofs(
  errandId: string,
  caller: { id?: number; role?: string } | undefined
) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");

  const role = String(caller?.role || "").toUpperCase();
  const callerId = caller?.id;

  if (role === "OWNER" || role === "DISPATCHER") return errand;

  if (role === "CUSTOMER") {
    if (errand.customerId !== callerId) {
      throw new ServiceError(403, "Access denied: you can only view your own errands.");
    }
    return errand;
  }

  if (role === "RIDER") {
    if (errand.riderId !== callerId) {
      throw new ServiceError(403, "Access denied: you can only view errands assigned to you.");
    }
    return errand;
  }

  // Anything else is denied rather than allowed.
  //
  // Written as an allow-list on purpose: the deny-by-default version of this
  // check cannot be widened by accident. A role added to the system later —
  // or a token carrying none at all — has to be named here before it can read
  // another person's evidence, instead of arriving with access already granted.
  throw new ServiceError(403, "Access denied.");
}

/**
 * One image's bytes.
 *
 * Separate from the list, which omits every blob on purpose — five receipts
 * would otherwise be two megabytes of base64 returned to a screen showing
 * thumbnails. A viewer asks for the one it is about to display.
 */
export async function getProofImage(errandId: string, imageId: number) {
  const image = await prisma.errandProofImage.findUnique({
    where: { id: imageId },
    select: { id: true, errandId: true, kind: true, mimeType: true, imageData: true, capturedAt: true },
  });

  if (!image || image.errandId !== errandId) {
    throw new ServiceError(404, "That photo does not belong to this errand.");
  }
  return image;
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
      verified: true,
      declaredTotal: true,
      extraction: {
        select: { extractedTotal: true, confirmedTotal: true, status: true, engine: true },
      },
    },
    orderBy: { capturedAt: "asc" },
  });
}
