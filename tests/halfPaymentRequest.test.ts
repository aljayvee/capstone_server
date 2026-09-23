import { beforeEach, describe, expect, it, vi } from "vitest";

// The rider, holding every item, asks for the customer's 50% before heading to
// them. These pin who may ask, when, for how much, and who is told.

const ERRAND = "ERR-HALF";
const RIDER = 7;
const CUSTOMER = 42;
const DISPATCHER = 3;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    // The receipt an automatic confirmation cites: this errand's, unspent.
    errandProofImage: {
      findUnique: vi.fn(async () => ({ errandId: ERRAND, payment: null })),
    },
    errand: {
      findUnique: vi.fn(async () => ({
        riderId: RIDER,
        customerId: CUSTOMER,
        dispatchLogs: [{ dispatcherId: DISPATCHER }],
        rider: { firstName: "Rico", expoPushToken: "ExponentPushToken[rider]" },
        customer: { expoPushToken: "ExponentPushToken[customer]", information: { firstName: "Maria" } },
      })),
    },
  },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findByIdBasic: vi.fn(), update: vi.fn() },
}));
vi.mock("../src/repositories/paymentSelectionRepository.js", () => ({
  paymentSelectionRepository: { findByErrandId: vi.fn() },
}));
vi.mock("../src/repositories/errandPaymentRepository.js", () => ({
  errandPaymentRepository: {
    findOneOfKind: vi.fn(),
    findByErrandId: vi.fn(async () => []),
    findAmountsByErrandId: vi.fn(async () => []),
    create: vi.fn(),
  },
}));
vi.mock("../src/repositories/notificationRepository.js", () => ({
  notificationRepository: { create: vi.fn() },
}));
vi.mock("../src/lib/pushNotifications.js", () => ({ sendPushNotification: vi.fn() }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn() },
}));
vi.mock("../src/services/errandService.js", () => ({
  markItemsPurchased: vi.fn(),
  recalculateFee: vi.fn(),
}));
vi.mock("../src/services/proofImageService.js", () => ({ confirmedReceiptTotal: vi.fn() }));

import { errandRepository } from "../src/repositories/errandRepository.js";
import { paymentSelectionRepository } from "../src/repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../src/repositories/errandPaymentRepository.js";
import { notificationRepository } from "../src/repositories/notificationRepository.js";
import { sendPushNotification } from "../src/lib/pushNotifications.js";
import { eventPublisher } from "../src/lib/eventPublisher.js";
import * as errandService from "../src/services/errandService.js";
import { confirmedReceiptTotal } from "../src/services/proofImageService.js";
import { requestHalfPayment, confirmUpfrontPayment } from "../src/services/errandPaymentService.js";

/** ₱1,170 of real receipts on the 50% plan, the rider at the last shop. */
function errand(overrides: Record<string, unknown> = {}) {
  return {
    id: ERRAND,
    riderId: RIDER,
    customerId: CUSTOMER,
    status: "IN_TRANSIT",
    estimatedCost: 1170,
    totalCost: 1290,
    halfPaymentRequestedAt: null,
    overageEscalatedAt: null,
    overageResolvedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(errandRepository.findByIdBasic).mockResolvedValue(errand() as never);
  vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
    paymentMode: { name: "GCash / PayMaya" },
  } as never);
  vi.mocked(errandPaymentRepository.findOneOfKind).mockResolvedValue(null as never);
  vi.mocked(confirmedReceiptTotal).mockResolvedValue(1170);
});

describe("who may ask, and when", () => {
  it("refuses a rider the errand is not assigned to", async () => {
    await expect(requestHalfPayment(ERRAND, 99)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a cash-on-delivery errand, where there is no half to ask for", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
      paymentMode: { name: "Cash on Delivery" },
    } as never);
    await expect(requestHalfPayment(ERRAND, RIDER)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("cash on delivery"),
    });
  });

  it("refuses once the half is already in, and says to go", async () => {
    vi.mocked(errandPaymentRepository.findOneOfKind).mockResolvedValue({ id: "p1" } as never);
    await expect(requestHalfPayment(ERRAND, RIDER)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Head to the customer"),
    });
  });

  it("refuses before any receipt is filed: the half comes from what was paid", async () => {
    vi.mocked(confirmedReceiptTotal).mockResolvedValue(0);
    await expect(requestHalfPayment(ERRAND, RIDER)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("receipts"),
    });
    expect(errandRepository.update).not.toHaveBeenCalled();
  });
});

describe("asking", () => {
  it("asks for half of the rider's receipts and tells all three parties", async () => {
    const result = await requestHalfPayment(ERRAND, RIDER);

    expect(result.ledger.dueUpFront).toBe(585);
    expect(result.repeat).toBe(false);
    expect(errandRepository.update).toHaveBeenCalledWith(ERRAND, {
      halfPaymentRequestedAt: expect.any(Date),
    });

    const parties = { riderId: RIDER, customerId: CUSTOMER };
    expect(eventPublisher.emitToErrandParties).toHaveBeenCalledWith(
      ERRAND,
      parties,
      "errand:half_payment_requested",
      expect.objectContaining({ dueUpFront: 585, goodsTotal: 1170, customerName: "Maria" })
    );
    expect(eventPublisher.emitToErrandParties).toHaveBeenCalledWith(
      ERRAND,
      parties,
      "errand:payment_updated",
      expect.objectContaining({ reason: "half_payment_requested" })
    );

    // The customer is pushed; the dispatcher who claimed it gets it in their bell.
    expect(notificationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER, type: "HALF_PAYMENT_REQUESTED" })
    );
    expect(notificationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: DISPATCHER, type: "HALF_PAYMENT_REQUESTED" })
    );
    expect(sendPushNotification).toHaveBeenCalledWith(
      "ExponentPushToken[customer]",
      expect.objectContaining({ data: { errandId: ERRAND, type: "HALF_PAYMENT_REQUESTED" } })
    );
  });

  it("re-syncs the goods figure when a receipt has not folded in yet", async () => {
    vi.mocked(confirmedReceiptTotal).mockResolvedValue(1250);
    await requestHalfPayment(ERRAND, RIDER);
    expect(errandService.markItemsPurchased).toHaveBeenCalledWith(ERRAND, RIDER, 1250);
  });

  it("a second press nudges without moving the stamp", async () => {
    const first = new Date("2026-09-23T08:00:00Z");
    vi.mocked(errandRepository.findByIdBasic).mockResolvedValue(
      errand({ halfPaymentRequestedAt: first }) as never
    );

    const result = await requestHalfPayment(ERRAND, RIDER);

    expect(result).toMatchObject({ repeat: true, requestedAt: first });
    expect(errandRepository.update).not.toHaveBeenCalled();
    expect(eventPublisher.emitToErrandParties).toHaveBeenCalledWith(
      ERRAND,
      expect.anything(),
      "errand:half_payment_requested",
      expect.objectContaining({ repeat: true })
    );
  });
});

describe("settling", () => {
  it("an automatic confirmation must name the receipt it came from", async () => {
    await expect(confirmUpfrontPayment(ERRAND, null, { amount: 585 })).rejects.toMatchObject({
      status: 400,
    });
    expect(errandPaymentRepository.create).not.toHaveBeenCalled();
  });

  it("tells the rider to go, with what is left to collect at the door", async () => {
    // After the write, the ledger holds the half.
    vi.mocked(errandPaymentRepository.findOneOfKind).mockResolvedValue(null as never);
    vi.mocked(errandPaymentRepository.findByErrandId).mockResolvedValue([
      { id: "p1", kind: "UPFRONT", amount: 585, confirmedAt: new Date(), note: null, confirmedBy: null },
    ] as never);
    vi.mocked(errandPaymentRepository.findAmountsByErrandId).mockResolvedValue([
      { kind: "UPFRONT", amount: 585 },
    ] as never);
    // loadPlan's summary is taken BEFORE the write: nothing paid yet.
    vi.mocked(errandPaymentRepository.findByErrandId).mockResolvedValueOnce([] as never);

    await confirmUpfrontPayment(ERRAND, null, { amount: 585, proofImageId: 11 });

    expect(errandPaymentRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "UPFRONT", amount: 585, confirmedByUserId: null, proofImageId: 11 })
    );
    expect(notificationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: RIDER,
        type: "HALF_PAYMENT_SETTLED",
        // 1290 whole bill less the 585 in hand.
        body: expect.stringContaining("₱705.00"),
      })
    );
    expect(eventPublisher.emitToErrandParties).toHaveBeenCalledWith(
      ERRAND,
      { riderId: RIDER, customerId: CUSTOMER },
      "errand:payment_updated",
      expect.objectContaining({ reason: "upfront_confirmed" })
    );
  });

  it("does not send the rider while a receipt overage is still open", async () => {
    vi.mocked(errandRepository.findByIdBasic).mockResolvedValue(
      errand({ overageEscalatedAt: new Date() }) as never
    );
    vi.mocked(errandPaymentRepository.findByErrandId)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValue([
        { id: "p1", kind: "UPFRONT", amount: 585, confirmedAt: new Date(), note: null, confirmedBy: null },
      ] as never);

    await confirmUpfrontPayment(ERRAND, null, { amount: 585, proofImageId: 11 });

    expect(notificationRepository.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "HALF_PAYMENT_SETTLED" })
    );
  });
});
