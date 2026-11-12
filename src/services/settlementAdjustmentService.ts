import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";
import { settlementAdjustmentRepository } from "../repositories/settlementAdjustmentRepository.js";
import {
  ADJUSTMENT_LABEL,
  adjustmentRefusal,
  canUndoAdjustment,
  settlementBalance,
  type AdjustmentKind,
} from "./patterns/settlementBalance.js";
import { syncTransactionStatusQuietly } from "./transactionStatusService.js";

/**
 * Money that settles part of a short cash handover after the fact.
 *
 * The handover (SettlementRecord) is never edited: it is what was counted at
 * the door. What happened afterwards is a SettlementAdjustment, recorded by a
 * dispatcher or owner either while resolving the Help Desk problem or later
 * from "Money still owed". See patterns/settlementBalance for the arithmetic.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface RecordAdjustmentInput {
  errandId: string;
  kind: AdjustmentKind;
  amount: number;
  reference?: string | null;
  note?: string | null;
  userId: number;
  reviewId?: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function recordWithin(db: Db, input: RecordAdjustmentInput) {
  const settlement = await db.settlementRecord.findUnique({
    where: { errandId: input.errandId },
    select: { id: true, variance: true, adjustments: { select: { kind: true, amount: true, voidedAt: true } } },
  });
  if (!settlement) {
    throw new ServiceError(404, "No cash handover has been recorded for this order.");
  }

  const balance = settlementBalance(settlement.variance, settlement.adjustments);
  const refusal = adjustmentRefusal(balance, input);
  if (refusal) throw new ServiceError(400, refusal);

  const adjustment = await settlementAdjustmentRepository.create(
    {
      settlementId: settlement.id,
      kind: input.kind,
      amount: round2(input.amount),
      reference: input.reference?.trim() || null,
      note: input.note?.trim() || null,
      reviewId: input.reviewId ?? null,
      recordedById: input.userId,
    },
    db
  );

  return {
    adjustment,
    balance: settlementBalance(settlement.variance, [...settlement.adjustments, adjustment]),
  };
}

/**
 * Records one amount against a short handover. Serializable, so two people
 * recording at once cannot both fit under what is still owed.
 */
export async function recordAdjustment(input: RecordAdjustmentInput) {
  const result = await prisma.$transaction((tx) => recordWithin(tx, input), {
    isolationLevel: "Serializable",
  });
  syncTransactionStatusQuietly(input.errandId);
  return result;
}

/**
 * Resolves a cash-short Help Desk problem and records what happened to the
 * money, in one transaction: the decision and the amount are saved together or
 * not at all.
 *
 * The review row is written with the same rules as exceptionService's
 * resolveException (trimmed reason, frozen amount). It lives here rather than
 * there because exceptionService stays free of service imports.
 */
export async function resolveCashShort(input: {
  errandId: string;
  reviewerId: number;
  reason: string;
  amountAtRisk: number;
  outcome: { kind: AdjustmentKind; amount: number; reference?: string | null };
}) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ServiceError(400, "Say why this is being cleared — a reason is what makes the record evidence.");
  }

  const review = await prisma.$transaction(
    async (tx) => {
      const created = await tx.exceptionReview.create({
        data: {
          errandId: input.errandId,
          kind: "CASH_VARIANCE",
          reviewerId: input.reviewerId,
          reason,
          amountAtRisk: round2(Math.abs(input.amountAtRisk)),
        },
      });
      await recordWithin(tx, {
        errandId: input.errandId,
        kind: input.outcome.kind,
        amount: input.outcome.amount,
        reference: input.outcome.reference,
        userId: input.reviewerId,
        reviewId: created.id,
      });
      return created;
    },
    { isolationLevel: "Serializable" }
  );

  syncTransactionStatusQuietly(input.errandId);
  return review;
}

/**
 * Undoes an adjustment: only its recorder, only within UNDO_WINDOW_MS. The row
 * is marked voided, never deleted, so who recorded what stays on file.
 */
export async function voidAdjustment(errandId: string, adjustmentId: number, userId: number) {
  const adjustment = await settlementAdjustmentRepository.findById(adjustmentId);
  if (!adjustment || adjustment.settlement.errandId !== errandId) {
    throw new ServiceError(404, "That payment record was not found.");
  }
  if (adjustment.voidedAt) {
    throw new ServiceError(409, "That payment record was already undone.");
  }
  if (!canUndoAdjustment(adjustment, userId)) {
    throw new ServiceError(
      403,
      "Only the person who recorded this can undo it, and only within 10 minutes of recording it."
    );
  }

  const changed = await settlementAdjustmentRepository.voidIfStanding(adjustmentId, userId);
  if (changed === 0) throw new ServiceError(409, "That payment record was already undone.");
  syncTransactionStatusQuietly(errandId);
}

const personName = (p: { firstName: string | null; lastName: string | null; username?: string | null } | null) =>
  p ? `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || p.username || "Someone" : "Someone";

/**
 * Every short handover that still has money owed, newest first, with what has
 * been recorded against it and whether the asking user may undo each entry.
 */
export async function listMoneyStillOwed(userId: number) {
  const rows = await settlementAdjustmentRepository.findShortSettlementsWithAdjustments();
  const now = new Date();

  return rows
    .map((s) => {
      const balance = settlementBalance(s.variance, s.adjustments);
      return {
        errandId: s.errandId,
        referenceNo: s.errand?.referenceNo ?? null,
        riderId: s.riderId,
        riderName: personName(s.rider),
        settledAt: s.settledAt.toISOString(),
        expected: s.expectedAmount,
        collected: s.collectedAmount,
        shortReason: s.shortReason,
        short: balance.short,
        paidSoFar: round2(balance.riderPaidBack + balance.customerPaid),
        writtenOff: balance.writtenOff,
        stillOwed: balance.stillOwed,
        adjustments: s.adjustments.map((a) => ({
          id: a.id,
          kind: a.kind,
          label: ADJUSTMENT_LABEL[a.kind as AdjustmentKind] ?? a.kind,
          amount: a.amount,
          reference: a.reference,
          note: a.note,
          recordedAt: a.recordedAt.toISOString(),
          recordedBy: personName(a.recordedBy),
          voided: Boolean(a.voidedAt),
          canUndo: canUndoAdjustment(a, userId, now),
        })),
      };
    })
    // Kept while anything is owed, and for the 10 minutes an entry can still be
    // undone: a full payment recorded by mistake must not vanish from the one
    // place it can be taken back.
    .filter((row) => row.stillOwed > 0 || row.adjustments.some((a) => a.canUndo));
}
