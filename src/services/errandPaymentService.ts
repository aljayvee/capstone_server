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
import { confirmedReceiptTotal } from "./proofImageService.js";

/**
 * The money on any errand the customer does not pay in cash at the door.
 *
 * Payment arrives on the company's Facebook Page, outside this system. There is
 * no callback to trust — a dispatcher looks at the page and says they saw it —
 * so every function here is an attestation being recorded, and every one of them
 * records WHO made it. That is the whole control.
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
  /** The goods figure the half is taken on: the rider's receipts once they exist. */
  goodsTotal: number;
  /** When the rider, holding every item, asked for the half. Null until then. */
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
        goodsSubtotal: errand.estimatedCost,
        grandTotal: errand.totalCost,
        entries: entries.map((e) => ({ kind: e.kind, amount: e.amount })),
        overagePending: isOveragePending(errand),
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
export type PaymentUpdateReason =
  | "half_payment_requested"
  | "proof_uploaded"
  | "upfront_confirmed"
  | "balance_confirmed"
  | "overage_resolved"
  | "refunded";

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
  const parties = await loadParties(errandId);
  eventPublisher.emitToErrandParties(
    errandId,
    { riderId: parties?.riderId, customerId: parties?.customerId },
    "errand:payment_updated",
    { errandId, reason, ledger: view, at: new Date().toISOString() }
  );
  return view;
}

/**
 * Tells the rider to go, and the customer that their money counted.
 *
 * Only once the goods are actually free to leave: with a receipt overage still
 * open the half is paid but the rider must stay, and "head to the customer"
 * would send them to a door they then cannot hand anything over at.
 */
async function announceHalfSettled(errandId: string, view: PaymentLedgerView, amount: number) {
  if (view.state !== "AWAITING_BALANCE" && view.state !== "SETTLED") return;
  const parties = await loadParties(errandId);
  if (!parties) return;

  if (parties.riderId) {
    const content = notificationFactory.halfPaymentSettled(parties.customerName, view.balanceDue ?? 0);
    await notificationRepository.create({ userId: parties.riderId, ...content });
    void sendPushNotification(parties.riderPushToken, {
      title: content.title,
      body: content.body,
      data: { errandId, type: content.type },
      urgent: true,
    });
  }

  const received = notificationFactory.halfPaymentReceived(amount);
  await notificationRepository.create({ customerId: parties.customerId, ...received });
  void sendPushNotification(parties.customerPushToken, {
    title: received.title,
    body: received.body,
    data: { errandId, type: received.type },
  });
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

/**
 * The customer paid what was owed before dispatch. Recorded so a rider can go.
 *
 * One function for both plans: half the goods on the 50% plan, the whole bill on
 * GCash / Bank Transfer / Card. The amount differs, the act does not — money
 * arrived on the Facebook Page and a dispatcher is vouching for it.
 *
 * `confirmedByUserId` is null when no person is: paymentProofService confirms
 * a customer's receipt on its own once it passes every check. It must then
 * carry the proof image, which is the only evidence left standing.
 */
export async function confirmUpfrontPayment(
  errandId: string,
  confirmedByUserId: number | null,
  input: { amount: number; note?: string; proofImageId?: number }
) {
  if (confirmedByUserId === null && !input.proofImageId) {
    throw new ServiceError(400, "An automatic confirmation needs the receipt it was read from.");
  }
  const { selection, summary } = await loadPlan(errandId);
  assertHasLedger(selection);

  if (await errandPaymentRepository.findOneOfKind(errandId, "UPFRONT")) {
    throw new ServiceError(409, "The payment for this errand is already confirmed.");
  }

  assertAmountMatches(input.amount, summary!.dueUpFront, "payment");
  const proofImageId = await assertProofImageAvailable(errandId, input.proofImageId);

  await errandPaymentRepository.create({
    errandId,
    kind: "UPFRONT",
    amount: input.amount,
    confirmedByUserId,
    note: input.note?.trim() || null,
    proofImageId,
  });

  const view = await getPaymentLedger(errandId);
  eventPublisher.emitToErrand(errandId, "errand:upfront_confirmed", view);
  await publishPaymentUpdate(errandId, "upfront_confirmed", view);
  await announceHalfSettled(errandId, view, input.amount);
  return view;
}

/**
 * The rider has every item and asks for the customer's half before heading out.
 *
 * The half is taken on what the rider actually paid, which is only known now:
 * each confirmed receipt already folds into the errand's goods figure
 * (proofImageService.confirmProofImage), so the amount asked for here is half
 * of real receipts, not of the customer's estimate. Asking before the receipts
 * exist is refused for that reason.
 *
 * Safe to press twice. The first press is stamped; a later one re-sends the
 * alerts as a nudge without moving the stamp, so "waiting since" stays true.
 */
export async function requestHalfPayment(errandId: string, riderId: number) {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");
  if (errand.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: this errand isn't assigned to you.");
  }
  if (errand.status !== "IN_TRANSIT") {
    throw new ServiceError(409, "Accept the errand and buy the items before asking for the half-payment.");
  }

  const selection = await paymentSelectionRepository.findByErrandId(errandId);
  if (!hasPaymentLedger(selection)) {
    throw new ServiceError(
      409,
      "This errand is cash on delivery, so there's no half-payment to ask for. Head to the customer."
    );
  }
  if (await errandPaymentRepository.findOneOfKind(errandId, "UPFRONT")) {
    throw new ServiceError(409, "The customer's half-payment is already settled. Head to the customer.");
  }

  const goodsTotal = await confirmedReceiptTotal(errandId);
  if (goodsTotal <= 0) {
    throw new ServiceError(
      409,
      "File the receipts for what you bought first, so the half comes from what you actually paid."
    );
  }
  // Normally already equal. Re-synced through the one existing path in case a
  // receiptless declaration landed without a confirm to fold it in.
  if (Math.abs(goodsTotal - errand.estimatedCost) > 0.005) {
    await errandService.markItemsPurchased(errandId, riderId, goodsTotal);
  }

  const firstAsk = errand.halfPaymentRequestedAt == null;
  const requestedAt = errand.halfPaymentRequestedAt ?? new Date();
  if (firstAsk) {
    await errandRepository.update(errandId, { halfPaymentRequestedAt: requestedAt });
  }

  const view = await getPaymentLedger(errandId);
  const parties = await loadParties(errandId);
  const amount = view.dueUpFront ?? 0;

  eventPublisher.emitToErrandParties(
    errandId,
    { riderId: parties?.riderId, customerId: parties?.customerId },
    "errand:half_payment_requested",
    {
      errandId,
      customerId: parties?.customerId ?? null,
      customerName: parties?.customerName ?? null,
      riderId,
      riderName: parties?.riderName ?? null,
      goodsTotal: view.goodsTotal,
      dueUpFront: amount,
      requestedAt,
      repeat: !firstAsk,
    }
  );
  await publishPaymentUpdate(errandId, "half_payment_requested", view);

  if (parties) {
    const toCustomer = notificationFactory.halfPaymentRequested(amount, view.goodsTotal);
    await notificationRepository.create({ customerId: parties.customerId, ...toCustomer });
    void sendPushNotification(parties.customerPushToken, {
      title: toCustomer.title,
      body: toCustomer.body,
      data: { errandId, type: toCustomer.type },
      urgent: true,
    });

    if (parties.dispatcherId) {
      const toStaff = notificationFactory.halfPaymentRequestedStaff(parties.customerName, amount);
      await notificationRepository.create({ userId: parties.dispatcherId, ...toStaff });
    }
  }

  logger.info(
    `Errand ${errandId}: rider ${riderId} asked for the half-payment, ₱${amount} of ₱${view.goodsTotal}` +
      (firstAsk ? "." : " (again).")
  );
  return { ledger: view, requestedAt, repeat: !firstAsk };
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
 * The receipt beat what the customer agreed to. Hold the goods.
 *
 * Called from markItemsPurchased, at the one moment the real total becomes
 * known — which is also, unavoidably, after the rider has already paid for the
 * goods. There is no longer any way to ask the customer first, so the choice is
 * between billing them something they never agreed to and stopping to ask. This
 * stops to ask.
 *
 * Returns whether it escalated, so the caller can decide what to tell whom.
 */
export async function checkReceiptOverage(
  errandId: string,
  receiptTotal: number
): Promise<{ escalated: boolean; overage: number; agreedBasket: number | null }> {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");

  const selection = await paymentSelectionRepository.findByErrandId(errandId);
  const agreedBasket = errand.quotedHandlingBasket;

  // Nothing to exceed. An errand the customer never confirmed a basket for has
  // no agreement to breach, and a COD errand is settled in full at the door
  // anyway — the company is not fronting anything it cannot recover.
  if (!hasPaymentLedger(selection) || agreedBasket == null) {
    return { escalated: false, overage: 0, agreedBasket };
  }

  const overage = Math.round((receiptTotal - agreedBasket) * 100) / 100;
  if (overage <= OVERAGE_ESCALATION_PESOS) {
    return { escalated: false, overage, agreedBasket };
  }

  await errandRepository.update(errandId, { overageEscalatedAt: new Date() });
  eventPublisher.emitToErrand(errandId, "errand:overage_escalated", {
    errandId,
    agreedBasket,
    receiptTotal,
    overage,
  });
  logger.warn(
    `Errand ${errandId}: receipt ₱${receiptTotal} exceeds agreed basket ₱${agreedBasket} by ₱${overage} — goods held.`
  );

  return { escalated: true, overage, agreedBasket };
}

/**
 * Whether the goods may be handed over, and if not, why — in the rider's words.
 *
 * The rider cannot fix either of these, so both read as a wait rather than a
 * task. A 409 with no explanation at the door is how a rider ends up standing in
 * front of a customer with no idea what to say.
 */
export async function assertGoodsReleasable(errandId: string): Promise<void> {
  const errand = await errandRepository.findByIdBasic(errandId);
  if (!errand) throw new ServiceError(404, "Errand not found");

  if (isOveragePending(errand)) {
    throw new ServiceError(
      409,
      "The receipt came in higher than the customer agreed to. The office is arranging the difference — hold the items until it clears."
    );
  }

  const selection = await paymentSelectionRepository.findByErrandId(errandId);
  if (!hasPaymentLedger(selection)) return;

  const entries = await errandPaymentRepository.findAmountsByErrandId(errandId);
  if (!entries.some((e) => e.kind === "UPFRONT")) {
    throw new ServiceError(
      409,
      "The customer's payment hasn't been confirmed yet — hold the items until the office confirms it."
    );
  }
}
