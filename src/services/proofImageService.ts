import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { readText, configuredEngines } from "../lib/ocr/resilientOcrService.js";
import { parseReceipt } from "../lib/ocr/receiptParser.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../repositories/errandPaymentRepository.js";
import { hasPaymentLedger } from "./patterns/paymentModes.js";
import { summarisePaymentPlan } from "./patterns/paymentLedger.js";
import { validateTransferReceipt } from "./patterns/transferValidation.js";
import { ServiceError } from "./ServiceError.js";
import * as errandService from "./errandService.js";
import { switchToCashOnDelivery } from "./paymentSelectionService.js";
import { holdScan, findScan, type ReceiptScan } from "../lib/pendingReceiptScans.js";
import { formatItemLabel } from "./patterns/itemLabel.js";
import type { ProofImageUploadInput, ProofImageScanInput } from "../validators/proofImageValidators.js";

/**
 * Below this many recognised characters, the photo is unusable rather than the
 * receipt being unusual. Measured against the three real fixtures, which return
 * 794-1014 characters; a blurred or mis-aimed shot returns single digits.
 */
const MIN_LEGIBLE_CHARACTERS = 40;

/** The rider's way out at the door when a transfer cannot be accepted (the user's call, 2026-10-08). */
const TAKE_CASH = "If it still won't go through, collect the payment in cash instead.";

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
 * Ensures all requested items assigned to a store (or across the errand)
 * have been verified (PURCHASED or OUT_OF_STOCK) before a receipt photo is accepted.
 */
async function assertAllStoreItemsChecked(errandId: string, pinpointId?: number | null) {
  if (!prisma.pabiliDetail) return;

  const items = await prisma.pabiliDetail.findMany({
    where: {
      errandId,
      ...(pinpointId != null ? { pinpointId } : {}),
    },
    select: {
      id: true,
      itemName: true,
      size: true,
      fulfillmentStatus: true,
      pinpointId: true,
    },
  });

  const targetItems = items.length > 0
    ? items
    : await prisma.pabiliDetail.findMany({
        where: { errandId },
        select: { id: true, itemName: true, size: true, fulfillmentStatus: true, pinpointId: true },
      });

  if (targetItems.length === 0) {
    return; // No pabili items (e.g. document courier / non-shopping errand)
  }

  const pendingItems = targetItems.filter(
    (item) => !item.fulfillmentStatus || item.fulfillmentStatus.toUpperCase() === "PENDING"
  );

  if (pendingItems.length > 0) {
    const itemNames = pendingItems.slice(0, 3).map((i) => `"${formatItemLabel(i.itemName, i.size)}"`).join(", ");
    const remainingCount = pendingItems.length > 3 ? ` and ${pendingItems.length - 3} more` : "";
    throw new ServiceError(
      422,
      `Please check all items (Purchased or Out of Stock) for this store before taking or uploading a receipt. Unchecked items: ${itemNames}${remainingCount}.`
    );
  }
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
  const errand = await assertRidersOwnErrand(errandId, riderId);

  if (input.kind === "RECEIPT" || input.kind === "NO_RECEIPT") {
    await assertAllStoreItemsChecked(errandId, input.pinpointId);
  }

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
        riderNote: input.riderNote?.trim() || null,
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
    await errandService.applyReceiptTotal(errandId, riderId, await confirmedReceiptTotal(errandId));

    // `extraction: null` rather than absent, so every caller sees one shape
    // whatever kind was uploaded.
    return { ...declared, clarityVerdict: null, extraction: null };
  }

  // Physical cash in hand — every cash collection now, ordinary COD or a
  // GCash/Maya customer paying cash instead of showing a receipt. Same
  // declared-figure shape as NO_RECEIPT, but this is money collected at
  // delivery, not goods bought at a shop, so it never feeds
  // applyReceiptTotal — that total is about the basket, not the payment.
  if (input.kind === "CASH_COLLECTED") {
    if (!input.declaredTotal || input.declaredTotal <= 0) {
      throw new ServiceError(400, "Enter what the customer handed you.");
    }

    const declared = await prisma.errandProofImage.create({
      data: {
        errandId,
        riderId,
        pinpointId: null,
        kind: "CASH_COLLECTED",
        imageData: base64,
        mimeType: input.mimeType,
        byteSize: input.fileSize,
        verified: false,
        declaredTotal: input.declaredTotal,
        riderNote: input.riderNote?.trim() || null,
      },
    });

    logger.info(
      `Errand ${errandId}: rider ${riderId} photographed ₱${input.declaredTotal} collected in cash.`
    );

    // On a GCash/PayMaya or bank errand this is the customer paying cash
    // instead, so the errand is now cash on delivery. The photo is already
    // saved and is the evidence either way: a failure here is logged, never
    // turned into a refused upload the rider would have to retake.
    try {
      if (await switchToCashOnDelivery(errandId)) {
        logger.info(`Errand ${errandId}: paid in cash instead of the chosen transfer; now Cash on Delivery.`);
      }
    } catch (err) {
      logger.warn(`Errand ${errandId}: could not record the switch to Cash on Delivery: ${String(err)}`);
    }

    return { ...declared, clarityVerdict: null, extraction: null };
  }

  // The rider's photo of the CUSTOMER's GCash, PayMaya or bank confirmation,
  // shown at the door. Since 2026-10-08 this is how a non-COD bill is paid: the
  // whole of it, at the door, read and recorded by the system with no
  // dispatcher (errandPaymentService.confirmBalanceFromRiderProof). Checked by
  // the shared validator: reference number, amount against the live balance,
  // same calendar day. Anything it cannot accept tells the rider to take cash.
  //
  // Always reads through Cloud Vision — never `input.deviceText`. TRANSFER
  // prefers on-device text because that path is a shopping-receipt
  // convenience; this one exists specifically to be an independently-read
  // check on money, so it always pays for the real read.
  if (input.kind === "RIDER_BALANCE_PROOF") {
    const selection = await paymentSelectionRepository.findByErrandId(errandId);
    if (!hasPaymentLedger(selection)) {
      throw new ServiceError(409, "This errand is cash on delivery — there's no balance to confirm.");
    }

    const entries = await errandPaymentRepository.findAmountsByErrandId(errandId);
    const plan = summarisePaymentPlan({ grandTotal: errand.totalCost, entries });

    if (plan.state !== "AWAITING_BALANCE") {
      throw new ServiceError(409, "This order is already paid. Hand the items over.");
    }

    const ocr = await readText(base64);
    if (!ocr) {
      const engineAvailable = configuredEngines().length > 0;
      throw new ServiceError(
        engineAvailable ? 422 : 503,
        engineAvailable
          ? `We couldn't read that photo. Retake it with the whole confirmation in frame. ${TAKE_CASH}`
          : `Transfer checks are unavailable right now. ${TAKE_CASH}`
      );
    }

    // The validator's sentences are written for the customer who sent it; at
    // the door the rider also needs the way out.
    let parsed: ReturnType<typeof validateTransferReceipt>;
    try {
      parsed = validateTransferReceipt({
        ocrText: ocr.text,
        dueAmount: plan.balanceDue,
        dueLabel: "balance",
      });
    } catch (err) {
      if (err instanceof ServiceError) throw new ServiceError(err.status, `${err.message} ${TAKE_CASH}`);
      throw err;
    }

    const image = await prisma.errandProofImage.create({
      data: {
        errandId,
        riderId,
        pinpointId: null,
        kind: "RIDER_BALANCE_PROOF",
        imageData: base64,
        mimeType: input.mimeType,
        byteSize: input.fileSize,
        clarityScore: parsed.characterCount,
        clarityVerdict: parsed.characterCount > 300 ? "SHARP" : "ACCEPTABLE",
        extraction: {
          create: {
            engine: ocr.engine,
            rawText: ocr.text,
            extractedTotal: parsed.amount,
            extractedDate: parsed.transactionDate,
            referenceNo: parsed.referenceNo,
            transactionId: parsed.transactionId,
            confidence: ocr.confidence,
            status: "OK",
          },
        },
      },
      include: { extraction: true },
    });

    logger.info(
      `Errand ${errandId}: rider ${riderId} photographed the customer's balance receipt — ` +
        `ref ${parsed.referenceNo}, ₱${parsed.amount}.`
    );

    // Recorded as paid now, by the system. Imported here rather than at the top:
    // errandPaymentService already imports this module.
    const { confirmBalanceFromRiderProof } = await import("./errandPaymentService.js");
    await confirmBalanceFromRiderProof(errandId, {
      proofImageId: image.id,
      amount: parsed.amount,
      referenceNo: parsed.referenceNo,
    });

    return image;
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
  const { ocr, parsed, status, clarityVerdict } = await readReceiptPhoto(input, base64);

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
 * Reads a receipt or transfer photo and judges it, storing nothing.
 *
 * Shared by the one-step upload above, which older rider apps still call, and
 * by scanProofImage, which holds the photo until the rider confirms it. Both
 * must refuse the same photos with the same words.
 */
async function readReceiptPhoto(
  input: { kind: string; deviceText?: string | null },
  base64: string
) {
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
        : "Receipt scanning is unavailable right now. Please try again in a moment. Your errand is not lost."
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
  const status: "OK" | "NEEDS_REVIEW" = parsed.total === null ? "NEEDS_REVIEW" : "OK";
  const clarityVerdict: "SHARP" | "ACCEPTABLE" = parsed.characterCount > 300 ? "SHARP" : "ACCEPTABLE";

  return { ocr, parsed, status, clarityVerdict };
}

/**
 * Reads a receipt photo and holds it, unsaved, for the rider to confirm.
 *
 * The rider looks at the total and either confirms it or retakes the photo.
 * Saving at this point is what filled errand_proof_images with every retake of
 * the same receipt, so nothing is written here: the photo waits in memory
 * (lib/pendingReceiptScans) and confirmScannedProof writes it once. A retake of
 * the same stop replaces the waiting photo.
 */
export async function scanProofImage(
  errandId: string,
  riderId: number,
  input: ProofImageScanInput
) {
  await assertRidersOwnErrand(errandId, riderId);

  if (input.kind === "RECEIPT") {
    await assertAllStoreItemsChecked(errandId, input.pinpointId);
  }

  const base64 = stripDataUri(input.imageData);
  const { ocr, parsed, status, clarityVerdict } = await readReceiptPhoto(input, base64);

  const scanId = holdScan({
    errandId,
    riderId,
    pinpointId: input.pinpointId ?? null,
    kind: input.kind,
    imageData: base64,
    mimeType: input.mimeType,
    byteSize: input.fileSize,
    clarityScore: parsed.characterCount,
    clarityVerdict,
    engine: ocr.engine,
    rawText: ocr.text,
    confidence: ocr.confidence,
    extractedTotal: parsed.total,
    extractedDate: parsed.transactionDate,
    status,
  });

  logger.info(
    `Errand ${errandId}: ${input.kind} read by ${ocr.engine}, waiting for the rider to confirm — ` +
      `${parsed.characterCount} chars, total ${parsed.total ?? "not found"}.`
  );

  return {
    scanId,
    kind: input.kind,
    clarityVerdict,
    extraction: {
      engine: ocr.engine,
      extractedTotal: parsed.total,
      extractedDate: parsed.transactionDate,
      status,
    },
  };
}

/** Writes a confirmed scan: the photo and its reading, with the rider's total. */
async function saveScan(scan: ReceiptScan, confirmedTotal: number, riderNote?: string | null): Promise<number> {
  const image = await prisma.errandProofImage.create({
    data: {
      errandId: scan.errandId,
      riderId: scan.riderId,
      pinpointId: scan.pinpointId,
      kind: scan.kind,
      imageData: scan.imageData,
      mimeType: scan.mimeType,
      byteSize: scan.byteSize,
      clarityScore: scan.clarityScore,
      clarityVerdict: scan.clarityVerdict,
      riderNote: riderNote?.trim() || null,
      extraction: {
        create: {
          engine: scan.engine,
          rawText: scan.rawText,
          extractedTotal: scan.extractedTotal,
          extractedDate: scan.extractedDate,
          confidence: scan.confidence,
          confirmedTotal,
          confirmedAt: new Date(),
          status: "OK",
        },
      },
    },
  });
  return image.id;
}

/**
 * The rider confirms (or corrects) the total of a scanned receipt, and only now
 * is the photo saved.
 *
 * Safe to send twice. On a weak signal the reply to the first confirm can be
 * lost after the row was written, and the rider presses Confirm again: that
 * second call applies the total to the row already written instead of writing
 * the receipt a second time.
 */
export async function confirmScannedProof(
  errandId: string,
  scanId: string,
  riderId: number,
  confirmedTotal: number,
  riderNote?: string | null
) {
  await assertRidersOwnErrand(errandId, riderId);

  const entry = findScan(scanId);
  if (!entry || entry.scan.errandId !== errandId || entry.scan.riderId !== riderId) {
    throw new ServiceError(410, "That photo was not saved in time. Please take it again.");
  }

  if (entry.scan.kind === "RECEIPT") {
    await assertAllStoreItemsChecked(errandId, entry.scan.pinpointId);
  }

  const firstConfirm = !entry.saving;
  if (firstConfirm) {
    const saving = saveScan(entry.scan, confirmedTotal, riderNote);
    entry.saving = saving;
    // A failed write leaves the scan confirmable again rather than stuck.
    saving.catch(() => {
      if (entry.saving === saving) entry.saving = undefined;
    });
  }
  const imageId = await entry.saving!;

  if (!firstConfirm) {
    const extraction = await confirmProofImage(errandId, imageId, riderId, confirmedTotal);
    return {
      id: imageId,
      kind: entry.scan.kind,
      extraction: {
        engine: extraction.engine,
        extractedTotal: extraction.extractedTotal,
        extractedDate: extraction.extractedDate,
        confirmedTotal: extraction.confirmedTotal,
        status: extraction.status,
      },
    };
  }

  // Written; the photo no longer needs holding in memory for anything but a
  // repeated confirm, which only needs the id.
  entry.scan.imageData = "";

  logger.info(`Errand ${errandId}: rider ${riderId} confirmed ${entry.scan.kind} ${imageId} at ${confirmedTotal}.`);
  await applyConfirmedTotal(errandId, imageId, riderId, entry.scan.kind, entry.scan.extractedTotal, confirmedTotal);

  return {
    id: imageId,
    kind: entry.scan.kind,
    extraction: {
      engine: entry.scan.engine,
      extractedTotal: entry.scan.extractedTotal,
      extractedDate: entry.scan.extractedDate,
      confirmedTotal,
      status: "OK" as const,
    },
  };
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

  await applyConfirmedTotal(errandId, imageId, riderId, image.kind, extraction.extractedTotal, confirmedTotal);

  return extraction;
}

/**
 * What a confirmed total sets in motion, whichever way it was confirmed: dispatch
 * hears about a large gap from the reading, and a receipt reprices the basket.
 */
async function applyConfirmedTotal(
  errandId: string,
  imageId: number,
  riderId: number,
  kind: string,
  extracted: number | null,
  confirmedTotal: number
) {
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
  // just the one being confirmed now. applyReceiptTotal assigns
  // `estimatedCost = receiptTotal` outright, so on a two-store run the second
  // receipt would otherwise overwrite the first — a rider who spent 176 at
  // Jollibee and 994 at SaveMore would bill the customer for 994 of goods and
  // the business would silently absorb the difference.
  //
  // Summing rather than adding also makes re-confirmation safe: correcting a
  // total recomputes the whole basket instead of double-counting it.
  if (kind === "RECEIPT") {
    await errandService.applyReceiptTotal(errandId, riderId, await confirmedReceiptTotal(errandId));
  }
}

/**
 * What the rider has confirmed spending on goods for this errand so far.
 *
 * Only confirmed figures count. An extraction the rider has not yet accepted is
 * a machine's guess, and a guess must never reach a customer's bill.
 */
export async function confirmedReceiptTotal(errandId: string): Promise<number> {
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

export function listProofImages(errandId: string, kind?: string) {
  return prisma.errandProofImage.findMany({
    where: { errandId, ...(kind ? { kind: kind as any } : {}) },
    // The blob is deliberately omitted: a list of five receipts would otherwise
    // be two megabytes of base64 nobody asked for. Fetch one by id to see it.
    select: {
      id: true,
      kind: true,
      pinpointId: true,
      riderId: true,
      customerId: true,
      mimeType: true,
      byteSize: true,
      clarityVerdict: true,
      capturedAt: true,
      verified: true,
      declaredTotal: true,
      supersededAt: true,
      extraction: {
        select: {
          extractedTotal: true,
          confirmedTotal: true,
          status: true,
          engine: true,
          referenceNo: true,
          transactionId: true,
          extractedDate: true,
        },
      },
    },
    orderBy: { capturedAt: "asc" },
  });
}
