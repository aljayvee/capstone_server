import { errandRepository } from "../repositories/errandRepository.js";
import { ServiceError } from "./ServiceError.js";
import { exceptionsFor } from "./exceptionService.js";
import {
  CONFIDENCE_THRESHOLD,
  EXCEPTION_KIND_ORDER,
  REASON_CODES,
  adviceRequest,
  isModelCompatible,
  secondOpinionWeight,
  suggestReason,
  type ReasonContext,
  type ReasonSuggestion,
  type SecondOpinion,
} from "./patterns/exceptionReasonModel.js";
import { adviseChoice } from "../lib/category/categoryServiceClient.js";
import { EXCEPTION_REASON_MODEL } from "./patterns/exceptionReasonWeights.js";
import { formatItemLabel } from "./patterns/itemLabel.js";
import type { ErrandException, ExceptionKind } from "./patterns/exceptionRules.js";

/**
 * Suggests a reason for clearing one exception in the Conflict Management queue.
 *
 * Reads only. The suggestion goes into the dispatcher's reason box and nothing
 * is recorded until they submit it through resolveException, so a wrong
 * suggestion costs an edit, never a record.
 *
 * The exception is re-derived here from the errand's evidence rather than taken
 * from the client. The model's inputs are the figures on the errand as the
 * server sees them, so a stale or edited copy in a browser cannot steer it.
 */

type EvidenceRow = NonNullable<Awaited<ReturnType<typeof errandRepository.findWithReconciliationEvidenceById>>>;

function planOf(modeName: string | null): ReasonContext["plan"] {
  if (modeName === null || modeName === "Cash on Delivery") return "COD";
  return /downpayment/i.test(modeName) ? "DOWNPAYMENT" : "OTHER";
}

/**
 * One errand's evidence, narrowed to what the model reads about one of its
 * exceptions. Exported for tests: this is the join between the database's
 * shape and the model's, and the place a wrong field would hide.
 */
export function toReasonContext(errand: EvidenceRow, exception: ErrandException): ReasonContext {
  // A replaced payment screenshot is the same payment uploaded twice.
  const live = errand.proofImages.filter((p) => !p.supersededAt);
  const count = (kind: string) => live.filter((p) => p.kind === kind).length;
  const at = exception.occurredAt.getTime();

  // exceptionsFor stamps each exception with the time of the evidence behind
  // it, which is how the proof, stop or dwell it is about is found again here.
  const proof = errand.proofImages.find((p) => p.capturedAt.getTime() === at) ?? null;
  const dwell =
    exception.kind === "STALLED_STOP"
      ? errand.dwellObservations.find((d) => d.stalled && d.departedAt.getTime() === at) ?? null
      : null;

  let stop: EvidenceRow["pinpoints"][number] | null = null;
  switch (exception.kind) {
    case "UNVERIFIED_PURCHASE":
    case "RECEIPT_DIVERGENCE":
      stop = errand.pinpoints.find((p) => p.id === proof?.pinpointId) ?? null;
      break;
    case "WRONG_BRANCH":
      stop = errand.pinpoints.find((p) => p.mismatchDetectedAt?.getTime() === at) ?? null;
      break;
    case "MISSING_RECEIPT":
      // Every missing-receipt row carries the errand's creation time, so the
      // stop is told apart by the name in its detail instead.
      stop =
        errand.pinpoints.find(
          (p) => exception.detail.includes(p.storeName) && !errand.proofImages.some((x) => x.pinpointId === p.id)
        ) ?? null;
      break;
    case "STALLED_STOP":
      stop = errand.pinpoints.find((p) => p.id === dwell?.pinpointId) ?? null;
      break;
  }

  const settlement = errand.settlement;
  const missed = settlement && settlement.status !== "MATCHED";
  const paidUpFront = errand.payments.reduce((sum, e) => sum + (e.kind === "REFUND" ? -e.amount : e.amount), 0);
  const purchases = live
    .filter((p) => p.kind === "RECEIPT" || p.kind === "NO_RECEIPT")
    .reduce((sum, p) => sum + (p.extraction?.confirmedTotal ?? p.declaredTotal ?? 0), 0);
  const divergence = exception.kind === "RECEIPT_DIVERGENCE" ? proof?.extraction : null;

  // Gather the rider's note from the specific proof image behind this exception,
  // any proof at the same stop, any cash/receiptless proof on the errand, and
  // the settlement's shortReason (filtering out the legacy boilerplate fallback).
  const rawShortReason = settlement?.shortReason?.trim() ?? "";
  const cleanShortReason =
    rawShortReason === "Reported short by the rider at handover." ? "" : rawShortReason;
  const stopProofNote =
    (proof?.riderNote?.trim() ||
      (stop ? live.find((p) => p.pinpointId === stop.id && p.riderNote?.trim())?.riderNote?.trim() : undefined) ||
      live.find((p) => p.riderNote?.trim())?.riderNote?.trim()) ??
    "";

  // Item-level checklist evidence from the rider's store checklist (pabili_details_tbl):
  // Covers both blurred receipts (CASH_VARIANCE / RECEIPT_DIVERGENCE) and receiptless
  // stores (UNVERIFIED_PURCHASE / NO_RECEIPT).
  const relevantItems =
    stop && stop.items.length > 0 ? stop.items : (errand.pabiliDetails ?? []);
  const withQuantity = (label: string, quantity: number) =>
    quantity > 1 ? `${label} x${quantity}` : label;
  const outOfStockItems = relevantItems
    .filter((i) => i.fulfillmentStatus === "OUT_OF_STOCK")
    .map((i) => withQuantity(formatItemLabel(i.itemName, i.size), i.quantity));
  const purchasedItems = relevantItems
    .filter((i) => i.fulfillmentStatus === "PURCHASED")
    .map((i) => withQuantity(formatItemLabel(i.itemName, i.size), i.quantity));

  const checklistNotes: string[] = [];
  if (outOfStockItems.length > 0) {
    checklistNotes.push(`Out of stock items reported by rider: ${outOfStockItems.join(", ")}`);
  }
  if (
    purchasedItems.length > 0 &&
    (exception.kind === "UNVERIFIED_PURCHASE" || count("NO_RECEIPT") > 0)
  ) {
    checklistNotes.push(
      `Rider checklist verified ${purchasedItems.length}/${relevantItems.length} items purchased (${purchasedItems.join(", ")})`
    );
  }

  const combinedRiderNote = Array.from(
    new Set([stopProofNote, cleanShortReason, ...checklistNotes].filter(Boolean))
  ).join(" | ");

  return {
    kind: exception.kind,
    amountAtRisk: exception.amountAtRisk,
    billTotal: errand.totalCost,
    basket: errand.estimatedCost,
    plan: planOf(errand.paymentSelection?.paymentMode.name ?? null),
    cashDirection: missed ? (settlement.variance < 0 ? "SHORT" : settlement.variance > 0 ? "OVER" : "NONE") : "NONE",
    riderNote: combinedRiderNote,
    receiptPhotos: count("RECEIPT"),
    noReceiptPhotos: count("NO_RECEIPT"),
    hasCashPhoto: count("CASH_COLLECTED") > 0,
    hasDeliveryPhoto: count("PROOF_OF_DELIVERY") > 0,
    transferProofs: count("PAYMENT_PROOF"),
    hasRiderBalanceProof: count("RIDER_BALANCE_PROOF") > 0,
    settledInFull: settlement?.status === "MATCHED",
    paidUpFront,
    scannedTotal: divergence?.extractedTotal ?? 0,
    confirmedTotal: divergence?.confirmedTotal ?? 0,
    storeName: stop?.storeName ?? "",
    observedName: stop?.observedPlace?.name ?? "",
    itemsAtStop: stop?.items.length ?? 0,
    receiptsCoverBasket: purchases / Math.max(errand.estimatedCost, 1),
    dwellMinutes: dwell ? dwell.dwellSeconds / 60 : 0,
  };
}

/**
 * Gemini's reading of the same evidence (Gemma's when Gemini is paused),
 * through the category service, which holds the key. Null whenever there is
 * none to be had: no service, no key, a spent quota, a timeout. The network
 * then answers alone, exactly as it did before this existed.
 *
 * Where it earns its call is the rider's note or when the local network is
 * uncertain (< 75%). The network reads a note through three word lists
 * ("sukli", "gcash", "tip"); "Walang receipt tong mga items na toh" or
 * "Cash nalang daw" is read by Gemini 3.8 Flash alongside the errand's facts.
 */
export async function askSecondOpinion(context: ReasonContext): Promise<SecondOpinion | null> {
  const request = adviceRequest(context);
  const advice = await adviseChoice(request);
  if (!advice?.available || typeof advice.confidence !== "number" || !advice.model) return null;
  const code = advice.code ?? null;
  // Only an answer among the options sent is an answer.
  if (code !== null && (!REASON_CODES.includes(code) || !request.options.some((o) => o.code === code))) {
    return null;
  }
  return { reasonCode: code, confidence: advice.confidence, model: advice.model, label: advice.label ?? advice.model };
}

export async function suggestExceptionReason(
  errandId: string,
  kind: ExceptionKind,
  occurredAt?: Date
): Promise<ReasonSuggestion> {
  // A model trained before the encoder changed would still answer, wrongly.
  // Refusing is the honest failure; the dispatcher can still write the reason.
  if (!isModelCompatible(EXCEPTION_REASON_MODEL)) {
    throw new ServiceError(503, "Reason suggestions are unavailable until the model is retrained.");
  }

  // A kind the network was never trained on has no input for it, and every
  // reason is masked off for it, so asking would return noise. Say nothing,
  // which is what an unconfident suggestion already means to the dispatcher.
  if (!EXCEPTION_KIND_ORDER.includes(kind)) {
    return {
      confident: false,
      confidence: 0,
      threshold: CONFIDENCE_THRESHOLD,
      reasonCode: null,
      suggestion: null,
      modelVersion: EXCEPTION_REASON_MODEL.version,
      source: "model",
      localConfidence: 0,
      secondOpinion: null,
    };
  }

  const errand = await errandRepository.findWithReconciliationEvidenceById(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");

  const candidates = exceptionsFor(errand).filter((e) => e.kind === kind);
  if (candidates.length === 0) {
    throw new ServiceError(404, "This errand no longer has that exception. Refresh the queue.");
  }

  // Several of one kind (two receiptless stops, say) are told apart by the
  // time on the row the dispatcher opened.
  const target =
    (occurredAt && candidates.find((e) => e.occurredAt.getTime() === occurredAt.getTime())) || candidates[0];

  const context = toReasonContext(errand, target);
  const prelim = suggestReason(EXCEPTION_REASON_MODEL, context, null, 0);
  const weight = secondOpinionWeight(context, prelim.localConfidence);
  const opinion = weight > 0 ? await askSecondOpinion(context) : null;
  return suggestReason(EXCEPTION_REASON_MODEL, context, opinion, weight);
}
