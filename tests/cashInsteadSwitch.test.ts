import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A GCash/PayMaya or bank customer who pays the rider cash at the door
 * ("They're paying cash instead"). The errand becomes Cash on Delivery; the
 * customer's own confirmed choice is left as it was, and the two disagreeing
 * is the record of the change.
 */

const ERRAND = "ERR-CASH-INSTEAD";
const COD_ID = 1;
const GCASH_ID = 2;

vi.mock("../src/repositories/paymentSelectionRepository.js", () => ({
  paymentSelectionRepository: { findByErrandId: vi.fn(), create: vi.fn() },
}));
vi.mock("../src/repositories/paymentModeRepository.js", () => ({
  paymentModeRepository: { findById: vi.fn(), findByName: vi.fn() },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findByIdBasic: vi.fn(), findById: vi.fn(), update: vi.fn() },
}));
vi.mock("../src/repositories/customerTransactionRepository.js", () => ({
  customerTransactionRepository: { updatePaymentMethodByErrandId: vi.fn(), updateAmountByErrandId: vi.fn() },
}));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emitToErrandParties: vi.fn() },
}));
vi.mock("../src/services/errandService.js", () => ({
  recalculateFee: vi.fn(),
  attachErrandNames: vi.fn((errand: unknown) => ({ ...(errand as object), named: true })),
}));

import { paymentSelectionRepository } from "../src/repositories/paymentSelectionRepository.js";
import { paymentModeRepository } from "../src/repositories/paymentModeRepository.js";
import { errandRepository } from "../src/repositories/errandRepository.js";
import { customerTransactionRepository } from "../src/repositories/customerTransactionRepository.js";
import { eventPublisher } from "../src/lib/eventPublisher.js";
import { recalculateFee } from "../src/services/errandService.js";
import { switchToCashOnDelivery } from "../src/services/paymentSelectionService.js";
import { paymentMethodChangeOf } from "../src/services/patterns/paymentModes.js";

const selection = (name: string) => ({ paymentMode: { name } }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paymentModeRepository.findByName).mockResolvedValue({ id: COD_ID, name: "Cash on Delivery" } as any);
  vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({ id: ERRAND, paymentModeId: GCASH_ID } as any);
  vi.mocked(errandRepository.findById).mockResolvedValue({ id: ERRAND, riderId: 7, customerId: 42 } as any);
});

describe("paying cash instead of the chosen transfer", () => {
  it("moves a GCash/PayMaya errand to Cash on Delivery", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue(selection("GCash / PayMaya"));

    await expect(switchToCashOnDelivery(ERRAND)).resolves.toBe(true);

    expect(errandRepository.update).toHaveBeenCalledWith(ERRAND, { paymentModeId: COD_ID });
    // The customer's choice is history, not rewritten.
    expect(paymentSelectionRepository.create).not.toHaveBeenCalled();
    // Nothing is repriced by the switch.
    expect(recalculateFee).not.toHaveBeenCalled();
  });

  it("tells the customer's and rider's screens", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue(selection("GCash / PayMaya"));

    await switchToCashOnDelivery(ERRAND);

    expect(eventPublisher.emitToErrandParties).toHaveBeenCalledWith(
      ERRAND,
      { riderId: 7, customerId: 42 },
      "order:updated",
      expect.objectContaining({ id: ERRAND, named: true })
    );
  });

  it("takes off the non-COD fee, and only that fee", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue(selection("GCash / PayMaya"));
    vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({
      id: ERRAND,
      paymentModeId: GCASH_ID,
      nonCodFee: 20,
      deliveryFee: 90,
      totalCost: 590,
      quotedDeliveryFee: 90,
    } as any);

    await switchToCashOnDelivery(ERRAND);

    expect(errandRepository.update).toHaveBeenCalledWith(ERRAND, {
      paymentModeId: COD_ID,
      nonCodFee: 0,
      deliveryFee: 70,
      totalCost: 570,
      // The agreed fare too, or recalculateFee would hold the fare to it and
      // put the fee back on the next reprice.
      quotedDeliveryFee: 70,
    });
    expect(customerTransactionRepository.updateAmountByErrandId).toHaveBeenCalledWith(ERRAND, 570);
    // Not re-measured: a fresh route at the door could move more than the fee.
    expect(recalculateFee).not.toHaveBeenCalled();
  });

  it("leaves an unagreed fare's quote unset", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue(selection("GCash / PayMaya"));
    vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({
      id: ERRAND,
      paymentModeId: GCASH_ID,
      nonCodFee: 15,
      deliveryFee: 65,
      totalCost: 365.5,
      quotedDeliveryFee: null,
    } as any);

    await switchToCashOnDelivery(ERRAND);

    expect(errandRepository.update).toHaveBeenCalledWith(ERRAND, {
      paymentModeId: COD_ID,
      nonCodFee: 0,
      deliveryFee: 50,
      totalCost: 350.5,
    });
  });

  it("changes no money when there was no non-COD fee", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue(selection("GCash / PayMaya"));
    vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({
      id: ERRAND,
      paymentModeId: GCASH_ID,
      nonCodFee: null,
      deliveryFee: 70,
      totalCost: 570,
    } as any);

    await switchToCashOnDelivery(ERRAND);

    expect(errandRepository.update).toHaveBeenCalledWith(ERRAND, { paymentModeId: COD_ID });
    expect(customerTransactionRepository.updateAmountByErrandId).not.toHaveBeenCalled();
  });

  it("moves a bank transfer errand too", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue(selection("Bank Transfer"));
    await expect(switchToCashOnDelivery(ERRAND)).resolves.toBe(true);
  });

  it("leaves a cash on delivery errand alone", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue(selection("Cash on Delivery"));

    await expect(switchToCashOnDelivery(ERRAND)).resolves.toBe(false);
    expect(errandRepository.update).not.toHaveBeenCalled();
    expect(eventPublisher.emitToErrandParties).not.toHaveBeenCalled();
  });

  it("leaves an errand with no confirmed choice alone", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue(null);
    await expect(switchToCashOnDelivery(ERRAND)).resolves.toBe(false);
    expect(errandRepository.update).not.toHaveBeenCalled();
  });

  it("does nothing the second time, so a retaken cash photo is harmless", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue(selection("GCash / PayMaya"));
    vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({ id: ERRAND, paymentModeId: COD_ID } as any);

    await expect(switchToCashOnDelivery(ERRAND)).resolves.toBe(false);
    expect(errandRepository.update).not.toHaveBeenCalled();
  });
});

describe("reporting the change on an errand", () => {
  it("reports a transfer paid in cash as from the transfer to cash", () => {
    expect(
      paymentMethodChangeOf({
        paymentSelection: selection("GCash / PayMaya"),
        paymentMode: { name: "Cash on Delivery" },
      })
    ).toEqual({ from: "GCash / PayMaya", to: "Cash on Delivery" });
  });

  it("reports nothing while the two agree", () => {
    expect(
      paymentMethodChangeOf({ paymentSelection: selection("GCash / PayMaya"), paymentMode: { name: "GCash / PayMaya" } })
    ).toBeNull();
    expect(
      paymentMethodChangeOf({ paymentSelection: selection("Cash on Delivery"), paymentMode: { name: "Cash on Delivery" } })
    ).toBeNull();
  });

  it("reports nothing before a choice, or without the errand's own mode", () => {
    expect(paymentMethodChangeOf({ paymentSelection: null, paymentMode: { name: "Cash on Delivery" } })).toBeNull();
    expect(paymentMethodChangeOf({ paymentSelection: selection("GCash / PayMaya"), paymentMode: null })).toBeNull();
  });
});
