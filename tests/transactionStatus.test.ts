import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveTransactionStatus } from "../src/services/patterns/transactionStatus.js";

/**
 * customer_transactions.status was written once, as PENDING, and never again,
 * so the Transaction Summary's paymentStatus column said PENDING for every
 * errand (2026-10-09). It is now re-derived from the errand, its ledger and its
 * cash settlement whenever any of them moves.
 */

const ledger = (amountPaid: number, balanceDue: number, state = balanceDue > 0 ? "AWAITING_BALANCE" : "SETTLED") =>
  ({ amountPaid, balanceDue, state }) as const;

describe("deriveTransactionStatus", () => {
  describe("cancelled", () => {
    it("is cancelled on cash on delivery, where nothing changed hands", () => {
      expect(deriveTransactionStatus({ errandStatus: "CANCELLED", ledger: null, settlement: null })).toBe("CANCELLED");
    });

    it("follows the ledger when money came in and goes back", () => {
      const refunded = { amountPaid: 0, balanceDue: 1120, state: "REFUNDED" as const };
      expect(deriveTransactionStatus({ errandStatus: "CANCELLED", ledger: refunded, settlement: null })).toBe("REFUNDED");
    });

    it("is cancelled on a transfer mode that never took a peso", () => {
      const unpaid = { amountPaid: 0, balanceDue: 1120, state: "CANCELLED" as const };
      expect(deriveTransactionStatus({ errandStatus: "CANCELLED", ledger: unpaid, settlement: null })).toBe("CANCELLED");
    });
  });

  describe("cash on delivery", () => {
    it.each(["PENDING", "ASSIGNED", "IN_TRANSIT", "DELIVERED"])("is pending at %s until the rider settles", (status) => {
      expect(deriveTransactionStatus({ errandStatus: status, ledger: null, settlement: null })).toBe("PENDING");
    });

    it.each([
      ["MATCHED", "PAID"],
      ["OVER", "PAID"],
      ["SHORT", "SHORT"],
    ])("reads a %s settlement as %s", (settled, expected) => {
      expect(deriveTransactionStatus({ errandStatus: "DELIVERED", ledger: null, settlement: { status: settled } })).toBe(
        expected
      );
    });
  });

  describe("GCash / PayMaya / Bank Transfer", () => {
    it("is pending while a balance is owed", () => {
      expect(deriveTransactionStatus({ errandStatus: "IN_TRANSIT", ledger: ledger(0, 1120), settlement: null })).toBe(
        "PENDING"
      );
    });

    it("is paid once the transfer clears the bill", () => {
      expect(deriveTransactionStatus({ errandStatus: "DELIVERED", ledger: ledger(1120, 0), settlement: null })).toBe("PAID");
    });

    it("is not paid on a bill that has not been priced yet", () => {
      expect(deriveTransactionStatus({ errandStatus: "AVAILABLE", ledger: ledger(0, 0), settlement: null })).toBe("PENDING");
    });

    it("trusts the cash settlement when the customer paid the rider in cash instead", () => {
      expect(
        deriveTransactionStatus({ errandStatus: "DELIVERED", ledger: ledger(0, 1120), settlement: { status: "MATCHED" } })
      ).toBe("PAID");
    });
  });
});

const { errand, entries, settlement, updateStatusByErrandId } = vi.hoisted(() => ({
  errand: {} as any,
  entries: [] as Array<{ kind: string; amount: number }>,
  settlement: { current: null as null | { status: string } },
  updateStatusByErrandId: vi.fn(async () => undefined),
}));

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findByIdBasic: vi.fn(async () => errand) },
}));
vi.mock("../src/repositories/paymentSelectionRepository.js", () => ({
  paymentSelectionRepository: { findByErrandId: vi.fn(async () => ({ id: 1 })) },
}));
vi.mock("../src/repositories/errandPaymentRepository.js", () => ({
  errandPaymentRepository: { findAmountsByErrandId: vi.fn(async () => entries) },
}));
vi.mock("../src/repositories/settlementRepository.js", () => ({
  settlementRepository: { findByErrandId: vi.fn(async () => settlement.current) },
}));
vi.mock("../src/repositories/customerTransactionRepository.js", () => ({
  customerTransactionRepository: { updateStatusByErrandId },
}));
vi.mock("../src/services/patterns/paymentModes.js", async (orig) => ({
  ...(await orig<object>()),
  hasPaymentLedger: vi.fn(() => true),
}));

const { syncTransactionStatus } = await import("../src/services/transactionStatusService.js");

describe("syncTransactionStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(errand, { id: "ERR-T", status: "DELIVERED", totalCost: 1120 });
    entries.length = 0;
    settlement.current = null;
  });

  it("writes PAID once the ledger clears the bill", async () => {
    entries.push({ kind: "FINAL", amount: 1120 });
    await syncTransactionStatus("ERR-T");
    expect(updateStatusByErrandId).toHaveBeenCalledWith("ERR-T", "PAID");
  });

  it("tells the ledger the errand is cancelled, so a refund reads as one", async () => {
    errand.status = "CANCELLED";
    entries.push({ kind: "FINAL", amount: 1120 }, { kind: "REFUND", amount: 1120 });
    await syncTransactionStatus("ERR-T");
    expect(updateStatusByErrandId).toHaveBeenCalledWith("ERR-T", "REFUNDED");
  });
});
