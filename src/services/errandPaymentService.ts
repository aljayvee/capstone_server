import { prisma } from "../lib/prisma.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { errandPaymentRepository } from "../repositories/errandPaymentRepository.js";
import { paymentSelectionRepository } from "../repositories/paymentSelectionRepository.js";
import { hasPaymentLedger } from "./patterns/paymentModes.js";
import {
  summarisePaymentPlan,
  OVERAGE_ESCALATION_PESOS,
  isOveragePending,
  type PaymentPlanSummary,
} from "./patterns/paymentLedger.js";
import { ServiceError } from "./ServiceError.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { logger } from "../lib/logger.js";
import { sendPushNotification } from "../lib/pushNotifications.js";
import { notificationRepository } from "../repositories/notificationRepository.js";
import { notificationFactory } from "./patterns/notificationFactory.js";
import * as errandService from "./errandService.js";
import { syncTransactionStatusQuietly } from "./transactionStatusService.js";
import * as notificationService from "./notificationService.js";
import { referenceLabel } from "../lib/errandReference.js";

/**
 * The money on any errand the customer does not pay in cash.
 *
 * Since 2026-10-08 GCash / PayMaya and Bank Transfer are paid at the door, the
 * way cash on delivery is: no 50% before delivery, nothing held, no dispatcher
 * step. The rider photographs the customer's transfer confirmation, the system
 * reads it against the bill and records it here (confirmBalanceFromRiderProof);
 * one it cannot accept is paid in cash instead. Every row still records who, or
 * which photo, vouched for it. That is the whole control.
 *
 * Guard order mirrors paymentSelectionService.confirmPaymentSelection: exists,
 * then applicable, then not already done, then the amount makes sense. Each
 * failure names what the person should do rather than what rule they broke.
 */

/** How far a confirmed amount may sit from what is due before it is refused. */
const AMOUNT_TOLERANCE_PESOS = 1;

export interface PaymentLedgerView extends Partial<PaymentPlanSummary> {
  errandId: string;
  /** False on COD, where there is no ledger and nothing below applies. */
  hasLedger: boolean;
  /** The goods figure: the rider's receipts once they exist. */
  goodsTotal: number;
  /** When a rider asked for the 50% downpayment, on errands from before 2026-10-08. */
  halfPaymentRequestedAt: Date | null;
  overageEscalatedAt: Date | null;
  overageResolvedAt: Date | null;
  entries: Array<{
    id: string;
    kind: string;
    amount: number;
    confirmedAt: Date;
    note: string | null;
    confirmedBy: { id: number; name: string; role: string } | null;
  }>;
}

async function loadPlan(errandId: string) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) {
    throw new ServiceError(404, "Errand not found");
  }

  const selection = await paymentSelectionRepository.findByErrandId(errandId);
  const entries = await errandPaymentRepository.findByErrandId(errandId);

  const summary = hasPaymentLedger(selection)
    ? summarisePaymentPlan({
        grandTotal: errand.totalCost,
        entries: entries.map((e) => ({ kind: e.kind, amount: e.amount })),
        cancelled: errand.status === "CANCELLED",
      })
    : null;

  return { errand, selection, entries, summary };
}

// isOveragePending now lives in patterns/paymentLedger.ts (re-exported below)
// — a pure, dependency-free home so importing it doesn't drag this service's
// (and errandService's) heavier import graph along for the ride.
export { isOveragePending };

export async function getPaymentLedger(errandId: string): Promise<PaymentLedgerView> {
  const { errand, selection, entries, summary } = await loadPlan(errandId);

  return {
    ...(summary ?? {}),
    errandId,
    hasLedger: hasPaymentLedger(selection),
    goodsTotal: errand.estimatedCost,
    halfPaymentRequestedAt: errand.halfPaymentRequestedAt,
    overageEscalatedAt: errand.overageEscalatedAt,
    overageResolvedAt: errand.overageResolvedAt,
    entries: entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      amount: e.amount,
      confirmedAt: e.confirmedAt,
      note: e.note,
      confirmedBy: e.confirmedBy
        ? {
            id: e.confirmedBy.id,
            name: `${e.confirmedBy.firstName} ${e.confirmedBy.lastName}`.trim(),
            role: e.confirmedBy.role,
          }
        : null,
    })),
  };
}

/** Why a payment update was sent. Clients decide what to show from this. */
export type PaymentUpdateReason = "balance_confirmed" | "overage_resolved" | "refunded";

/** The rider, the customer and what to call each, for telling them things. */
async function loadParties(errandId: string) {
  const row = await prisma.errand.findUnique({
    where: { id: errandId },
    select: {
      riderId: true,
      customerId: true,
      // Whoever claimed it. The same derivation the dispatcher board uses.
      dispatchLogs: { select: { dispatcherId: true }, orderBy: { dispatchedAt: "desc" }, take: 1 },
      rider: { select: { firstName: true, expoPushToken: true } },
      customer: {
        select: { expoPushToken: true, information: { select: { firstName: true } } },
      },
    },
  });
  if (!row) return null;
  return {
    riderId: row.riderId,
    customerId: row.customerId,
    dispatcherId: row.dispatchLogs[0]?.dispatcherId ?? null,
    riderName: row.rider?.firstName?.trim() || "The rider",
    riderPushToken: row.rider?.expoPushToken ?? null,
    customerName: row.customer?.information?.firstName?.trim() || "The customer",
    customerPushToken: row.customer?.expoPushToken ?? null,
  };
}

/**
 * One event, to every party, whenever an errand's money moves.
 *
 * The three apps drifted apart because each payment act told a different
 * audience in a different event: the rider app heard none of them, the
 * customer's chat refreshed only on `order:updated`, and the dispatcher's
 * ledger panel only on its own button presses. This is the single signal all
 * three listen for, carrying the ledger itself so nobody has to refetch it.
 * The specific events (`errand:upfront_confirmed` and the rest) still go out
 * alongside, unchanged, for anything already listening to them.
 */
export async function publishPaymentUpdate(
  errandId: string,
  reason: PaymentUpdateReason,
  ledger?: PaymentLedgerView
): Promise<PaymentLedgerView> {
  const view = ledger ?? (await getPaymentLedger(errandId));
  // Every ledger row (FINAL, TOP_UP, REFUND) passes through here, which makes
  // it the one place the transaction row learns that money moved.
  syncTransactionStatusQuietly(errandId);
  const parties = await loadParties(errandId);
  eventPublisher.emitToErrandParties(
    errandId,
    { riderId: parties?.riderId, customerId: parties?.customerId },
    "errand:payment_updated",
    { errandId, reason, ledger: view, at: new Date().toISOString() }
  );
  if (parties?.customerId) {
    void tellCustomerAboutPayment(errandId, reason, view, {
      id: parties.customerId,
      expoPushToken: parties.customerPushToken,
    });
  }
  return view;
}

/** The customer's row for a payment milestone (user, 2026-10-21). Never throws. */
async function tellCustomerAboutPayment(
  errandId: string,
  reason: PaymentUpdateReason,
  view: PaymentLedgerView,
  customer: { id: number; expoPushToken: string | null }
) {
  try {
    const kind = reason === "balance_confirmed" ? "FINAL" : reason === "overage_resolved" ? "TOP_UP" : "REFUND";
    const latest = [...(view.entries ?? [])]
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => new Date(b.confirmedAt).getTime() - new Date(a.confirmedAt).getTime())[0];
    const amount = latest ? `₱${Number(latest.amount).toFixed(2)}` : null;
    const errand = `Errand ${await referenceLabel(errandId)}`;

    const content =
      reason === "balance_confirmed"
        ? {
            type: "PAYMENT_CONFIRMED" as const,
            title: "Payment received",
            body: amount ? `${errand}: we received your ${amount}. Thank you.` : `${errand}: your payment was received. Thank you.`,
          }
        : reason === "overage_resolved"
          ? {
              type: "EXTRA_CHARGE_RESOLVED" as const,
              title: "Extra charge settled",
              body: amount
                ? `${errand}: the ${amount} for items that cost more than expected is settled. Your rider can hand them over.`
                : `${errand}: the extra charge for items that cost more than expected is settled.`,
            }
          : {
              type: "PAYMENT_REFUNDED" as const,
              title: "Refund sent",
              body: amount ? `${errand}: ${amount} was refunded to you.` : `${errand}: your refund was sent.`,
            };

    await notificationService.notifyCustomer(customer, content.type, content, errandId);
  } catch (error) {
    logger.error(`Could not tell the customer about ${reason} on errand ${errandId}:`, error);
  }
}

function assertHasLedger(selection: Parameters<typeof hasPaymentLedger>[0]) {
  if (!hasPaymentLedger(selection)) {
    throw new ServiceError(
      409,
      "This errand is cash on delivery — the rider collects it at the door, so there's nothing to record here."
    );
  }
}

/**
 * The photo a dispatcher is looking at when they confirm — checked rather
 * than trusted, since a stale client could name a photo from a different
 * errand, or one that already backs a different payment (the DB's own
 * @unique constraint would refuse that too, but as a raw constraint error
 * instead of a reason the dispatcher can act on).
 */
async function assertProofImageAvailable(
  errandId: string,
  proofImageId: number | undefined
): Promise<number | undefined> {
  if (!proofImageId) return undefined;

  const image = await prisma.errandProofImage.findUnique({
    where: { id: proofImageId },
    select: { errandId: true, payment: { select: { id: true } } },
  });

  if (!image || image.errandId !== errandId) {
    throw new ServiceError(404, "That photo does not belong to this errand.");
  }
  if (image.payment) {
    throw new ServiceError(409, "That photo already backs a different confirmed payment.");
  }

  return proofImageId;
}

function assertAmountMatches(amount: number, due: number, what: string) {
  if (amount <= 0) {
    throw new ServiceError(400, `The ${what} has to be more than ₱0.`);
  }
  if (Math.abs(amount - due) > AMOUNT_TOLERANCE_PESOS) {
    throw new ServiceError(
      400,
      `That doesn't match the ${what} of ₱${due.toFixed(2)}. Check the amount before confirming it.`
    );
  }
}

/** What a retired 50% step answers, for apps installed before 2026-10-08. */
const DOWNPAYMENT_RETIRED =
  "The 50% payment is no longer used. The customer pays the whole bill at the door, like cash on delivery.";

/**
 * The dispatcher's confirmation of the 50% downpayment. Retired 2026-10-08:
 * nothing is owed before delivery, so there is nothing to confirm.
 */
export async function confirmUpfrontPayment(
  _errandId: string,
  _confirmedByUserId: number | null,
  _input: { amount: number; note?: string; proofImageId?: number }
): Promise<never> {
  throw new ServiceError(409, DOWNPAYMENT_RETIRED);
}

/**
 * The rider asking for the customer's half before heading to them. Retired
 * 2026-10-08: the rider heads straight to the customer, as on cash on delivery.
 * The plan the apps read never reports the half as owed, so an installed rider
 * app does not offer this; one that still asks is told to go.
 */
export async function requestHalfPayment(errandId: string, riderId: number): Promise<never> {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");
  if (errand.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: this errand isn't assigned to you.");
  }
  throw new ServiceError(409, `${DOWNPAYMENT_RETIRED} Head to the customer.`);
}

/**
 * The customer's transfer, photographed by the rider at the door, recorded as
 * paid with no person in the loop.
 *
 * The photo has already passed validateTransferReceipt in proofImageService: a
 * reference number, the amount within ₱1 of the whole balance, dated today.
 * What that cannot see is one confirmation shown at two doors, so a reference
 * number already used on another errand is refused, and the rider collects cash
 * instead (the user's call, 2026-10-08: nothing waits on a dispatcher).
 *
 * The row carries no person (confirmedByUserId null) and names the photo, so
 * the audit trail says exactly what vouched for it. The rider's cash settlement
 * then nets against it and expects nothing (settlementService).
 */
export async function confirmBalanceFromRiderProof(
  errandId: string,
  input: { proofImageId: number; amount: number; referenceNo: string }
): Promise<PaymentLedgerView> {
  if (await errandPaymentRepository.isReferenceUsedElsewhere(input.referenceNo, errandId)) {
    logger.warn(
      `Errand ${errandId}: transfer ref ${input.referenceNo} already paid for another errand; rider told to take cash.`
    );
    throw new ServiceError(
      409,
      "That confirmation's reference number was already used on another order. Collect the payment in cash instead."
    );
  }

  const { selection, summary } = await loadPlan(errandId);
  assertHasLedger(selection);
  if (summary!.state !== "AWAITING_BALANCE") {
    throw new ServiceError(409, "This order is already paid. Hand the items over.");
  }
  if (await errandPaymentRepository.findOneOfKind(errandId, "FINAL")) {
    throw new ServiceError(409, "This order is already paid. Hand the items over.");
  }
  assertAmountMatches(input.amount, summary!.balanceDue, "bill");
  const proofImageId = await assertProofImageAvailable(errandId, input.proofImageId);

  await errandPaymentRepository.create({
    errandId,
    kind: "FINAL",
    amount: input.amount,
    confirmedByUserId: null,
    note: `Paid by transfer at the door, ref ${input.referenceNo}. Read from the rider's photo.`,
    proofImageId,
  });

  const view = await getPaymentLedger(errandId);
  eventPublisher.emitToErrand(errandId, "errand:balance_confirmed", view);
  await publishPaymentUpdate(errandId, "balance_confirmed", view);
  logger.info(`Errand ${errandId}: ₱${input.amount} paid by transfer at the door, ref ${input.referenceNo}.`);
  return view;
}

/**
 * The customer paid the balance (what's left after the upfront half, or the
 * whole bill on a GCash/Bank Transfer plan) electronically instead of the
 * rider collecting it in cash at the door.
 *
 * Recorded as a FINAL entry — a kind the schema already had, unused until now.
 * summarisePaymentPlan already folds FINAL into amountPaid, so this one row is
 * the whole fix: balanceDue and state recompute to SETTLED with no further
 * bookkeeping, and a rider's later cash settlement nets against it on its own.
 */
export async function confirmBalancePayment(
  errandId: string,
  confirmedByUserId: number,
  input: { amount: number; note?: string; proofImageId?: number }
) {
  const { selection, summary } = await loadPlan(errandId);
  assertHasLedger(selection);

  if (await errandPaymentRepository.findOneOfKind(errandId, "FINAL")) {
    throw new ServiceError(409, "The balance on this errand is already confirmed.");
  }

  if (summary!.state !== "AWAITING_BALANCE") {
    throw new ServiceError(409, "There's no outstanding balance to confirm on this errand.");
  }

  assertAmountMatches(input.amount, summary!.balanceDue, "balance");
  const proofImageId = await assertProofImageAvailable(errandId, input.proofImageId);

  await errandPaymentRepository.create({
    errandId,
    kind: "FINAL",
    amount: input.amount,
    confirmedByUserId,
    note: input.note?.trim() || null,
    proofImageId,
  });

  const view = await getPaymentLedger(errandId);
  eventPublisher.emitToErrand(errandId, "errand:balance_confirmed", view);
  await publishPaymentUpdate(errandId, "balance_confirmed", view);
  // Confirmed by staff, so news to the rider: nothing left to collect at the
  // door. (A balance read from the rider's own proof photo is not told back.)
  void notificationService.notifyErrandRider(errandId, "RIDER_PAYMENT_CONFIRMED", (errand) => ({
    title: "Payment confirmed",
    body: `${errand}: the customer's ₱${input.amount.toFixed(2)} is confirmed. Nothing to collect, hand the items over.`,
  }));
  return view;
}

/**
 * The customer agreed to cover a receipt that came in higher than their
 * estimate, and the money has arrived.
 *
 * Clearing the escalation is the point: it re-stamps the handling-fee ceiling at
 * the basket the customer has now consented to, so the fee that was being held
 * down can move — and the rider can hand the goods over.
 */
export async function confirmTopUp(
  errandId: string,
  confirmedByUserId: number,
  input: { amount: number; note?: string }
) {
  const { errand, selection } = await loadPlan(errandId);
  assertHasLedger(selection);

  if (!isOveragePending(errand)) {
    throw new ServiceError(
      409,
      "There's no outstanding overage on this errand, so there's nothing to top up."
    );
  }

  if (input.amount <= 0) {
    throw new ServiceError(400, "The top-up has to be more than ₱0.");
  }

  await errandPaymentRepository.create({
    errandId,
    kind: "TOP_UP",
    amount: input.amount,
    confirmedByUserId,
    note: input.note?.trim() || null,
  });

  // Consent, recorded. The customer has now agreed to the real basket, so the
  // ceiling moves to it and recalculateFee is free to price on it — see
  // errandService.confirmOrder for the same stamp at the ordinary moment.
  await errandRepository.update(errandId, {
    overageResolvedAt: new Date(),
    quotedHandlingBasket: errand.estimatedCost,
    quotedHandlingFee: null,
  });
  await errandService.recalculateFee(errandId);

  const repriced = await errandRepository.findByIdBasic(errandId);
  if (repriced?.groceryFee != null) {
    await errandRepository.update(errandId, { quotedHandlingFee: repriced.groceryFee });
  }

  const view = await getPaymentLedger(errandId);
  eventPublisher.emitToErrand(errandId, "errand:overage_resolved", view);
  await publishPaymentUpdate(errandId, "overage_resolved", view);
  void notificationService.notifyErrandRider(errandId, "RIDER_EXTRA_CHARGE_SETTLED", (errand) => ({
    title: "Extra charge settled",
    body: `${errand}: the customer settled the extra ₱${input.amount.toFixed(2)}. You can hand the items over.`,
  }));
  logger.info(
    `Errand ${errandId}: overage topped up by ₱${input.amount} (user ${confirmedByUserId}); goods released.`
  );
  return view;
}

/**
 * Money going back — a cancellation after the downpayment landed.
 */
export async function recordRefund(
  errandId: string,
  confirmedByUserId: number,
  input: { amount: number; note?: string }
) {
  const { summary } = await loadPlan(errandId);

  if (!summary || summary.amountPaid <= 0) {
    throw new ServiceError(409, "Nothing has been paid on this errand, so there's nothing to refund.");
  }
  if (input.amount <= 0) {
    throw new ServiceError(400, "The refund has to be more than ₱0.");
  }
  if (input.amount > summary.amountPaid + AMOUNT_TOLERANCE_PESOS) {
    throw new ServiceError(
      400,
      `That's more than the ₱${summary.amountPaid.toFixed(2)} this customer has paid.`
    );
  }

  await errandPaymentRepository.create({
    errandId,
    kind: "REFUND",
    amount: input.amount,
    confirmedByUserId,
    note: input.note?.trim() || null,
  });

  const view = await getPaymentLedger(errandId);
  eventPublisher.emitToErrand(errandId, "errand:payment_refunded", view);
  await publishPaymentUpdate(errandId, "refunded", view);
  return view;
}

/**
 * Whether a receipt above the agreed basket stops the errand. It no longer does.
 *
 * It used to hold the goods on GCash and Bank Transfer errands until the office
 * arranged the difference, because the customer had paid half up front against
 * the estimate. With the downpayment retired on 2026-10-08 they run as cash on
 * delivery does, and cash on delivery never held: the customer pays the real
 * total at the door. Kept as a function so its two callers read the same answer
 * they always did, and an overage is still logged for the exception report.
 */
export async function checkReceiptOverage(
  errandId: string,
  receiptTotal: number
): Promise<{ escalated: boolean; overage: number; agreedBasket: number | null }> {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");

  const agreedBasket = errand.quotedHandlingBasket;
  const overage = agreedBasket == null ? 0 : Math.round((receiptTotal - agreedBasket) * 100) / 100;
  if (overage > OVERAGE_ESCALATION_PESOS) {
    logger.info(
      `Errand ${errandId}: receipt ₱${receiptTotal} is ₱${overage} above the agreed ₱${agreedBasket}; paid at the door.`
    );
  }
  return { escalated: false, overage, agreedBasket };
}

/**
 * Whether the goods may be handed over. Always, since 2026-10-08.
 *
 * Two holds used to live here: the 50% downpayment not yet confirmed, and a
 * receipt overage not yet cleared. Both went with the downpayment, so a GCash or
 * Bank Transfer errand hands over the way a cash on delivery one does, and the
 * customer pays at the door. An errand held before the change is released too.
 */
export async function assertGoodsReleasable(errandId: string): Promise<void> {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");
}
