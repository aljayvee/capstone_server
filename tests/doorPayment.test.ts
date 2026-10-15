import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GCash / PayMaya and Bank Transfer since 2026-10-08: paid in full at the door,
 * like cash on delivery. The rider photographs the customer's transfer and the
 * system records it; a transfer it cannot accept is paid in cash. The 50% steps
 * are refused with a sentence, for apps installed before the change.
 */

const ERRAND = "ERR-DOOR";
const OTHER = "ERR-ELSEWHERE";
const RIDER = 7;
const CUSTOMER = 42;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    // The photo the payment cites: this errand's, not yet backing a payment.
    errandProofImage: { findUnique: vi.fn(async () => ({ errandId: ERRAND, payment: null })) },
    errand: {
      findUnique: vi.fn(async () => ({
        riderId: RIDER,
        customerId: CUSTOMER,
        dispatchLogs: [],
        rider: { firstName: "Rico", expoPushToken: null },
        customer: { expoPushToken: null, information: { firstName: "Maria" } },
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
    isReferenceUsedElsewhere: vi.fn(async () => false),
    create: vi.fn(),
  },
}));
vi.mock("../src/repositories/notificationRepository.js", () => ({ notificationRepository: { create: vi.fn() } }));
vi.mock("../src/lib/pushNotifications.js", () => ({ sendPushNotification: vi.fn() }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn() },
}));
vi.mock("../src/services/errandService.js", () => ({ applyReceiptTotal: vi.fn(), recalculateFee: vi.fn() }));

import { errandRepository } from "../src/repositories/errandRepository.js";
import { paymentSelectionRepository } from "../src/repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../src/repositories/errandPaymentRepository.js";
import { eventPublisher } from "../src/lib/eventPublisher.js";
import {
  assertGoodsReleasable,
  checkReceiptOverage,
  confirmBalanceFromRiderProof,
  confirmUpfrontPayment,
  requestHalfPayment,
} from "../src/services/errandPaymentService.js";

/** ₱1,170 of real receipts and a ₱1,290 bill, on GCash. */
function errand(overrides: Record<string, unknown> = {}) {
  return {
    id: ERRAND,
    riderId: RIDER,
    customerId: CUSTOMER,
    status: "IN_TRANSIT",
    estimatedCost: 1170,
    totalCost: 1290,
    quotedHandlingBasket: 1000,
    halfPaymentRequestedAt: null,
    overageEscalatedAt: null,
    overageResolvedAt: null,
    ...overrides,
  };
}

const proof = { proofImageId: 11, amount: 1290, referenceNo: "012345678901" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(errandRepository.findByIdBasic).mockResolvedValue(errand() as never);
  vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
    paymentMode: { name: "GCash / PayMaya" },
  } as never);
  vi.mocked(errandPaymentRepository.findOneOfKind).mockResolvedValue(null as never);
  vi.mocked(errandPaymentRepository.isReferenceUsedElsewhere).mockResolvedValue(false);
  vi.mocked(errandPaymentRepository.findByErrandId).mockResolvedValue([] as never);
});

describe("the transfer the rider photographs at the door", () => {
  it("is recorded as the whole bill paid, by the system, citing the photo", async () => {
    await confirmBalanceFromRiderProof(ERRAND, proof);
    expect(errandPaymentRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "FINAL", amount: 1290, confirmedByUserId: null, proofImageId: 11 })
    );
    expect(eventPublisher.emitToErrandParties).toHaveBeenCalledWith(
      ERRAND,
      { riderId: RIDER, customerId: CUSTOMER },
      "errand:payment_updated",
      expect.objectContaining({ reason: "balance_confirmed" })
    );
  });

  it("is refused when its reference already paid another order, and the rider is told to take cash", async () => {
    vi.mocked(errandPaymentRepository.isReferenceUsedElsewhere).mockImplementation(
      async (_ref: string, errandId: string) => errandId !== OTHER
    );
    await expect(confirmBalanceFromRiderProof(ERRAND, proof)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("in cash instead"),
    });
    expect(errandPaymentRepository.create).not.toHaveBeenCalled();
  });

  it("is refused for less than the bill", async () => {
    await expect(confirmBalanceFromRiderProof(ERRAND, { ...proof, amount: 645 })).rejects.toMatchObject({ status: 400 });
    expect(errandPaymentRepository.create).not.toHaveBeenCalled();
  });

  it("is not recorded twice", async () => {
    vi.mocked(errandPaymentRepository.findByErrandId).mockResolvedValue([
      { id: "p1", kind: "FINAL", amount: 1290, confirmedAt: new Date(), note: null, confirmedBy: null },
    ] as never);
    await expect(confirmBalanceFromRiderProof(ERRAND, proof)).rejects.toMatchObject({ status: 409 });
    expect(errandPaymentRepository.create).not.toHaveBeenCalled();
  });

  it("nets a half paid before the change, so only the rest is owed", async () => {
    vi.mocked(errandPaymentRepository.findByErrandId).mockResolvedValue([
      { id: "p0", kind: "UPFRONT", amount: 585, confirmedAt: new Date(), note: null, confirmedBy: null },
    ] as never);
    await confirmBalanceFromRiderProof(ERRAND, { ...proof, amount: 705 });
    expect(errandPaymentRepository.create).toHaveBeenCalledWith(expect.objectContaining({ kind: "FINAL", amount: 705 }));
  });
});

describe("the retired 50% steps", () => {
  it("tell a rider who still asks for the half to head to the customer", async () => {
    await expect(requestHalfPayment(ERRAND, RIDER)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Head to the customer"),
    });
    expect(errandRepository.update).not.toHaveBeenCalled();
  });

  it("still refuse a rider the errand is not assigned to", async () => {
    await expect(requestHalfPayment(ERRAND, 99)).rejects.toMatchObject({ status: 403 });
  });

  it("refuse a dispatcher confirming a downpayment", async () => {
    await expect(confirmUpfrontPayment(ERRAND, 3, { amount: 645 })).rejects.toMatchObject({ status: 409 });
    expect(errandPaymentRepository.create).not.toHaveBeenCalled();
  });
});

describe("the goods at the door", () => {
  it("are released with nothing paid yet, as on cash on delivery", async () => {
    await expect(assertGoodsReleasable(ERRAND)).resolves.toBeUndefined();
  });

  it("are released even on an errand held for an overage before the change", async () => {
    vi.mocked(errandRepository.findByIdBasic).mockResolvedValue(errand({ overageEscalatedAt: new Date() }) as never);
    await expect(assertGoodsReleasable(ERRAND)).resolves.toBeUndefined();
  });

  it("are never held for a receipt above the agreed basket", async () => {
    await expect(checkReceiptOverage(ERRAND, 1500)).resolves.toMatchObject({ escalated: false, overage: 500 });
    expect(errandRepository.update).not.toHaveBeenCalled();
    expect(eventPublisher.emitToErrand).not.toHaveBeenCalled();
  });
});
