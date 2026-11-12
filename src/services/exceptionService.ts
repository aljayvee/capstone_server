import { prisma } from "../lib/prisma.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { ServiceError } from "./ServiceError.js";
import { settlementBalance } from "./patterns/settlementBalance.js";
import {
  MATERIALITY_PESOS,
  exceptionRate,
  isMaterial,
  isReceiptDivergent,
  rankExceptions,
  type ErrandException,
  type ExceptionKind,
} from "./patterns/exceptionRules.js";

/**
 * Errands that did not reconcile.
 *
 * Derived on read, never stored. Every figure this needs is already in the
 * database — settlement variance, the machine's reading beside the rider's
 * confirmed one, unverified purchases, wrong-branch visits — and none of it was
 * ever looked at again. There is no capture here and no scheduled job; this
 * turns evidence that already exists into a list a person can work through.
 *
 * The one thing it does NOT do is claim a three-way match. That needs three
 * independent money figures and there are two: PabiliDetail.unitPrice is zero on
 * every row, because the customer never enters prices and the dispatcher's item
 * edit does not write them. What is checked here is the receipt against the cash,
 * plus whether every stop that had items produced any evidence at all.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

const nameOf = (person: { firstName: string; lastName: string } | null | undefined) =>
  person ? `${person.firstName} ${person.lastName}`.trim() : null;

/** A resolution recorded against this errand for this kind, most recent first. */
type ReviewRow = {
  kind: string;
  reason: string;
  amountAtRisk: number;
  resolvedAt: Date;
  reviewer: { firstName: string; lastName: string } | null;
};

/**
 * The newest review that could have been about this occurrence.
 *
 * A review names an errand and a kind, nothing finer (ExceptionReview has no
 * proof or stop id, and the schema is locked), so it covers every occurrence of
 * that kind the reviewer could have seen: those the server already knew of when
 * it was written. One raised afterwards stays open. Until 2026-10-15 a review
 * also cleared everything of its kind raised later, so a third receiptless
 * purchase declared the day after the first two were cleared never showed
 * anywhere (errand 726f2cd9 in production, ₱70, declared 2026-09-30).
 *
 * `raisedAt` is the server's time wherever one exists, never later than the
 * moment the occurrence became visible. WRONG_BRANCH has only the rider's GPS
 * time: a fast phone clock (the tracking validators allow 5 minutes) can leave
 * one open after a review written in that window, which shows a row twice
 * rather than hiding one.
 */
function latestReview(reviews: ReviewRow[], kind: ExceptionKind, raisedAt: Date): ReviewRow | null {
  const forKind = reviews.filter((r) => r.kind === kind && r.resolvedAt >= raisedAt);
  if (forKind.length === 0) return null;
  return forKind.reduce((newest, r) => (r.resolvedAt > newest.resolvedAt ? r : newest));
}

type EvidenceRow = Awaited<
  ReturnType<typeof errandRepository.findWithReconciliationEvidenceBetween>
>[number];

/**
 * Every exception one errand raises.
 *
 * Deliberately returns exceptions that are already resolved, carrying their
 * resolution. The dispatcher's queue filters them out; the owner's report keeps
 * them, because "who cleared this and what did they say" is the part with teeth.
 */
/**
 * Whether an escalation has since been cleared.
 *
 * A later escalation beats an earlier resolution, so a second overage on the
 * same errand is not silently treated as already handled. Mirrors
 * errandPaymentService.isOveragePending, which is the one the gate consults —
 * kept as its own copy here because this module must stay free of service
 * imports to remain a pure rule.
 */
function isOverageResolved(errand: {
  overageEscalatedAt: Date | null;
  overageResolvedAt: Date | null;
}): boolean {
  if (!errand.overageResolvedAt) return false;
  if (!errand.overageEscalatedAt) return true;
  return errand.overageResolvedAt >= errand.overageEscalatedAt;
}

export function exceptionsFor(errand: EvidenceRow): ErrandException[] {
  const found: ErrandException[] = [];
  const riderName = nameOf(errand.rider);

  // `raisedAt`: when the server first knew of it, for matching reviews only.
  // `occurredAt` stays what the queue shows and ranks by.
  const push = (
    kind: ExceptionKind,
    amountAtRisk: number,
    detail: string,
    occurredAt: Date,
    raisedAt: Date = occurredAt,
    extra: Partial<ErrandException> = {}
  ) => {
    if (!isMaterial(kind, amountAtRisk)) return;

    const review = latestReview(errand.exceptionReviews as ReviewRow[], kind, raisedAt);
    found.push({
      errandId: errand.id,
      referenceNo: errand.referenceNo,
      kind,
      amountAtRisk: round2(Math.abs(amountAtRisk)),
      detail,
      riderId: errand.riderId ?? null,
      riderName,
      occurredAt,
      orderPlacedAt: errand.createdAt,
      resolvedAt: review?.resolvedAt ?? null,
      resolvedBy: review ? nameOf(review.reviewer) : null,
      resolutionReason: review?.reason ?? null,
      ...extra,
    });
  };

  // ── cash back against what was owed ──────────────────────────────────────
  //
  // Every detail below is read by a dispatcher deciding what to do, and printed
  // on the owner's Help Desk Report. Plain words, the figures that matter, and
  // the rider's own note when there is one; no accounting terms.
  const settlement = errand.settlement;
  if (settlement && settlement.status !== "MATCHED") {
    const gap = `₱${round2(Math.abs(settlement.variance))}`;
    const balance = settlementBalance(settlement.variance, settlement.adjustments ?? []);
    push(
      "CASH_VARIANCE",
      settlement.variance,
      `The rider should have handed over ₱${round2(settlement.expectedAmount)} but handed over ` +
        `₱${round2(settlement.collectedAmount)}, so the cash is ` +
        (settlement.variance < 0 ? `${gap} short.` : `${gap} over.`) +
        (settlement.shortReason ? ` Rider's note: ${settlement.shortReason}` : ""),
      settlement.settledAt,
      settlement.settledAt,
      {
        cash: {
          expected: round2(settlement.expectedAmount),
          collected: round2(settlement.collectedAmount),
          short: balance.short,
          stillOwed: balance.stillOwed,
        },
      }
    );
  }

  for (const proof of errand.proofImages) {
    // ── the rider's figure against the machine's ──────────────────────────
    const extracted = proof.extraction?.extractedTotal ?? null;
    const confirmed = proof.extraction?.confirmedTotal ?? null;

    if (extracted !== null && confirmed !== null && isReceiptDivergent(extracted, confirmed)) {
      push(
        "RECEIPT_DIVERGENCE",
        confirmed - extracted,
        `The rider entered ₱${round2(confirmed)} for this receipt, but the receipt photo reads ` +
          `₱${round2(extracted)}. Check the photo to see which is right.`,
        proof.capturedAt,
        // Divergent from the rider's confirmation, which can come well after
        // the photo, not from the photo itself.
        proof.extraction?.confirmedAt ?? proof.capturedAt
      );
    }

    // ── a purchase nothing corroborates ───────────────────────────────────
    //
    // Keyed on the kind, not on `verified` alone. CASH_COLLECTED is stored
    // unverified too (the rider's typed figure, no OCR), but it is the
    // customer's money taken at the door, not goods bought at a shop. Reading
    // it as a purchase listed every cash errand twice in the queue and held
    // the collected amount against the run as if it had been spent.
    if (proof.kind === "NO_RECEIPT" && proof.verified === false) {
      push(
        "UNVERIFIED_PURCHASE",
        proof.declaredTotal ?? 0,
        `The rider says they spent ₱${round2(proof.declaredTotal ?? 0)} at a shop that gives no ` +
          `receipt, so there is no receipt to prove it.`,
        proof.capturedAt
      );
    }
  }

  for (const stop of errand.pinpoints) {
    // ── settled at a different branch than the one pinned ─────────────────
    if (stop.mismatchDetectedAt) {
      push(
        "WRONG_BRANCH",
        0,
        `The errand said to buy at ${stop.storeName}, but the rider bought at ` +
          `${stop.observedPlace?.name ?? "a place that was not on the errand"}.`,
        stop.mismatchDetectedAt
      );
    }

    // ── a stop with items and nothing to show for it ──────────────────────
    //
    // Only for finished errands. A stop with no proof yet is a stop the rider
    // has not reached, which is the ordinary state of most of them.
    const finished = errand.status === "DELIVERED" || errand.status === "COMPLETED";
    const hasItems = stop.items.length > 0;
    const hasProof = errand.proofImages.some((p) => p.pinpointId === stop.id);

    if (finished && hasItems && !hasProof) {
      push(
        "MISSING_RECEIPT",
        0,
        // Keeps the store name: exceptionReasonService finds this stop by it.
        `${stop.items.length === 1 ? "1 item was" : `${stop.items.length} items were`} to be bought at ` +
          `${stop.storeName}, but the rider sent no receipt or amount for that stop.`,
        errand.createdAt
      );
    }
  }

  // ── goods held for an overage nobody has arranged ────────────────────────
  //
  // The most urgent thing this list can carry: a rider is standing still with
  // the company's goods, and the customer has agreed to none of it. Ages from
  // when it was raised, so a queue read top-down surfaces the oldest hold.
  if (errand.overageEscalatedAt && !isOverageResolved(errand)) {
    const overage = round2(errand.estimatedCost - (errand.quotedHandlingBasket ?? errand.estimatedCost));
    push(
      "OVERAGE_PENDING",
      overage,
      `The items cost ₱${round2(errand.estimatedCost)}, but the customer only agreed to ` +
        `₱${round2(errand.quotedHandlingBasket ?? 0)}. The extra ₱${round2(overage)} needs the ` +
        `customer's OK, so the rider is holding the items.`,
      errand.overageEscalatedAt
    );
  }

  // ── delivered, and the money never came ──────────────────────────────────
  //
  // Only for FINISHED errands: an outstanding balance mid-errand is the ordinary
  // state of every downpayment errand, and flagging those would drown the queue.
  //
  // Scoped to non-COD, because a COD errand's money is the settlement's job —
  // an unsettled one already shows as `awaitingCollection` in the settlement
  // report, and raising it here too would say the same thing twice.
  //
  // This deliberately covers the modes with NO ledger behind them — GCash /
  // PayMaya, Bank Transfer, Card. Those capture nothing, record nothing and
  // cannot be settled, so a delivered one was previously invisible everywhere:
  // goods out of the door, no money, and nothing in any queue saying so. If
  // those modes are switched on without a ledger, this is the only thing that
  // notices.
  const finishedErrand = errand.status === "DELIVERED" || errand.status === "COMPLETED";
  const modeName = errand.paymentSelection?.paymentMode.name ?? null;
  const isCod = modeName === null || modeName === "Cash on Delivery";

  if (finishedErrand && !isCod) {
    const paid = errand.payments.reduce(
      (sum, e) => sum + (e.kind === "REFUND" ? -e.amount : e.amount),
      0
    );
    const outstanding = round2(errand.totalCost - paid - (errand.settlement?.collectedAmount ?? 0));

    if (outstanding > 0) {
      push(
        "UNPAID_BALANCE",
        outstanding,
        paid > 0
          ? `Delivered, but ₱${round2(outstanding)} of the ₱${round2(errand.totalCost)} bill is ` +
              `still unpaid. The customer paid ₱${round2(paid)} in advance.`
          : `Delivered and paid by ${modeName}, but no payment of the ₱${round2(errand.totalCost)} ` +
              `bill was recorded. The app does not record payments made this way.`,
        errand.createdAt
      );
    }
  }

  // ── cancelled after the goods were bought ────────────────────────────────
  //
  // The rider spent the company's money, then the errand was cancelled: goods
  // in hand, nobody billed. No settlement can be filed for a cancelled errand
  // (settlementService settles deliveries only, and its expected-cash formula
  // would book the whole bill as the rider's shortfall), so nothing else in the
  // system notices. What happens to the goods is a person's call.
  //
  // The amount is what the receipts say was spent. With none on file it falls
  // back to the basket, which markItemsPurchased sets from the receipts anyway.
  if (errand.status === "CANCELLED") {
    const purchases = errand.proofImages.filter(
      (p) => !p.supersededAt && (p.kind === "RECEIPT" || p.kind === "NO_RECEIPT")
    );
    if (errand.itemsPurchasedAt || purchases.length > 0) {
      const spent = purchases.reduce((sum, p) => sum + (p.extraction?.confirmedTotal ?? p.declaredTotal ?? 0), 0);
      const atRisk = spent > 0 ? spent : errand.estimatedCost;
      const lastPurchase = purchases.reduce<Date | null>(
        (latest, p) => (!latest || p.capturedAt > latest ? p.capturedAt : latest),
        null
      );
      const receipts = purchases.length === 1 ? "1 receipt" : `${purchases.length} receipts`;
      push(
        "CANCELLED_AFTER_PURCHASE",
        atRisk,
        `The errand was cancelled after the rider had already bought ₱${round2(atRisk)} of items` +
          (purchases.length > 0 ? ` (${receipts} saved)` : "") +
          `. No one has paid for these items yet.`,
        errand.itemsPurchasedAt ?? lastPurchase ?? errand.createdAt
      );
    }
  }

  // ── far longer inside a shop than that kind of shop takes ────────────────
  for (const dwell of errand.dwellObservations) {
    if (!dwell.stalled) continue;
    const stop = errand.pinpoints.find((p) => p.id === dwell.pinpointId);
    push(
      "STALLED_STOP",
      0,
      `The rider spent ${Math.round(dwell.dwellSeconds / 60)} min at ${stop?.storeName ?? "a store"}. ` +
        `This kind of shop usually takes much less time.`,
      dwell.departedAt,
      // departedAt is the phone's GPS time, and an offline batch uploads late;
      // the row's own insert time is when the server learned of the dwell.
      dwell.createdAt ?? dwell.departedAt
    );
  }

  return found;
}

export interface ExceptionSummary {
  openCount: number;
  resolvedCount: number;
  totalAtRisk: number;
  byKind: Array<{ kind: ExceptionKind; count: number; atRisk: number }>;
}

export interface RiderExposure {
  riderId: number;
  riderName: string | null;
  errandCount: number;
  exceptionCount: number;
  /** Exceptions per errand — a rate, so volume does not read as fault. */
  rate: number;
  atRisk: number;
}

/**
 * Every exception across a range, plus the shape of it.
 *
 * `openOnly` is what separates the dispatcher's working queue from the owner's
 * period report: dispatch wants what is still outstanding, the owner wants the
 * whole picture including what was cleared and by whom.
 */
export async function findExceptions(start: Date, end: Date, options: { openOnly?: boolean } = {}) {
  const errands = await errandRepository.findWithReconciliationEvidenceBetween(start, end);

  let exceptions = errands.flatMap((errand) => exceptionsFor(errand));
  if (options.openOnly) exceptions = exceptions.filter((e) => e.resolvedAt === null);

  const ranked = rankExceptions(exceptions);

  const byKindMap = new Map<ExceptionKind, { count: number; atRisk: number }>();
  for (const e of ranked) {
    const entry = byKindMap.get(e.kind) ?? { count: 0, atRisk: 0 };
    entry.count += 1;
    entry.atRisk = round2(entry.atRisk + e.amountAtRisk);
    byKindMap.set(e.kind, entry);
  }

  const summary: ExceptionSummary = {
    openCount: ranked.filter((e) => e.resolvedAt === null).length,
    resolvedCount: ranked.filter((e) => e.resolvedAt !== null).length,
    totalAtRisk: round2(ranked.reduce((sum, e) => sum + e.amountAtRisk, 0)),
    byKind: [...byKindMap.entries()].map(([kind, v]) => ({ kind, ...v })),
  };

  // ── per-rider exposure, as a rate ────────────────────────────────────────
  const errandsPerRider = new Map<number, number>();
  for (const errand of errands) {
    if (errand.riderId === null) continue;
    errandsPerRider.set(errand.riderId, (errandsPerRider.get(errand.riderId) ?? 0) + 1);
  }

  const riderMap = new Map<number, RiderExposure>();
  for (const e of ranked) {
    if (e.riderId === null) continue;
    const entry = riderMap.get(e.riderId) ?? {
      riderId: e.riderId,
      riderName: e.riderName,
      errandCount: errandsPerRider.get(e.riderId) ?? 0,
      exceptionCount: 0,
      rate: 0,
      atRisk: 0,
    };
    entry.exceptionCount += 1;
    entry.atRisk = round2(entry.atRisk + e.amountAtRisk);
    riderMap.set(e.riderId, entry);
  }

  const riders = [...riderMap.values()]
    .map((r) => ({ ...r, rate: exceptionRate(r.exceptionCount, r.errandCount) }))
    .sort((a, b) => b.rate - a.rate);

  return { exceptions: ranked, summary, riders, materialityPesos: MATERIALITY_PESOS };
}

/**
 * Records that a person considered an exception and what they concluded.
 *
 * Writes a row ABOUT the exception; it never touches the proof, the extraction
 * or the settlement behind it. That is what keeps the rider's declared figure
 * and the machine's reading both intact, and it is the reason an owner reviewing
 * something a dispatcher already closed adds a second row rather than replacing
 * the first.
 */
export async function resolveException(input: {
  errandId: string;
  kind: ExceptionKind;
  reviewerId: number;
  reason: string;
  amountAtRisk: number;
}) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ServiceError(400, "Say why this is being cleared — a reason is what makes the record evidence.");
  }

  const errand = await errandRepository.findByIdBasic(input.errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");

  return prisma.exceptionReview.create({
    data: {
      errandId: input.errandId,
      kind: input.kind,
      reviewerId: input.reviewerId,
      reason,
      amountAtRisk: round2(Math.abs(input.amountAtRisk)),
    },
  });
}
