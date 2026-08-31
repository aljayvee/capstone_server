import { prisma } from "../lib/prisma.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { ServiceError } from "./ServiceError.js";
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

function latestReview(reviews: ReviewRow[], kind: ExceptionKind): ReviewRow | null {
  const forKind = reviews.filter((r) => r.kind === kind);
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
export function exceptionsFor(errand: EvidenceRow): ErrandException[] {
  const found: ErrandException[] = [];
  const riderName = nameOf(errand.rider);

  const push = (kind: ExceptionKind, amountAtRisk: number, detail: string, occurredAt: Date) => {
    if (!isMaterial(kind, amountAtRisk)) return;

    const review = latestReview(errand.exceptionReviews as ReviewRow[], kind);
    found.push({
      errandId: errand.id,
      kind,
      amountAtRisk: round2(Math.abs(amountAtRisk)),
      detail,
      riderId: errand.riderId ?? null,
      riderName,
      occurredAt,
      resolvedAt: review?.resolvedAt ?? null,
      resolvedBy: review ? nameOf(review.reviewer) : null,
      resolutionReason: review?.reason ?? null,
    });
  };

  // ── cash back against what was owed ──────────────────────────────────────
  const settlement = errand.settlement;
  if (settlement && settlement.status !== "MATCHED") {
    const direction = settlement.variance < 0 ? "short" : "over";
    push(
      "CASH_VARIANCE",
      settlement.variance,
      `Collected ₱${round2(settlement.collectedAmount)} against ₱${round2(settlement.expectedAmount)} — ` +
        `₱${round2(Math.abs(settlement.variance))} ${direction}.` +
        (settlement.shortReason ? ` Rider said: ${settlement.shortReason}` : ""),
      settlement.settledAt
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
        `Rider confirmed ₱${round2(confirmed)} on a receipt that scanned as ₱${round2(extracted)}.`,
        proof.capturedAt
      );
    }

    // ── a purchase nothing corroborates ───────────────────────────────────
    if (proof.verified === false) {
      push(
        "UNVERIFIED_PURCHASE",
        proof.declaredTotal ?? 0,
        `₱${round2(proof.declaredTotal ?? 0)} declared at a shop that issued no receipt.`,
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
        `Pinned to ${stop.storeName}, but the rider settled at ` +
          `${stop.observedPlace?.name ?? "an unpinned place"}.`,
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
        `${stop.items.length} item(s) at ${stop.storeName} with no receipt or declaration.`,
        errand.createdAt
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
      `${Math.round(dwell.dwellSeconds / 60)} min inside ${stop?.storeName ?? "a stop"} — ` +
        `well past what this kind of shop usually takes.`,
      dwell.departedAt
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
