import { beforeEach, describe, expect, it, vi } from "vitest";

// The Transaction Summary's one-rider view (owner, 2026-10-27), exercised
// against fixed rows the way settlementRevenueSplit.test.ts does it.
vi.mock("../src/repositories/customerTransactionRepository.js", () => ({
  customerTransactionRepository: { findBetween: vi.fn(async () => []) },
}));
vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: {
    findAllRiders: vi.fn(async () => [
      { id: 3, username: "caramel", firstName: "Renen", lastName: "Cadungog" },
      { id: 4, username: "tamad", firstName: "Juan", lastName: "Tamad" },
    ]),
  },
}));
vi.mock("../src/services/patterns/categoryFeeModes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/patterns/categoryFeeModes.js")>()),
  activeCategoryNameSet: vi.fn(async () => new Set<string>()),
}));

import { customerTransactionRepository } from "../src/repositories/customerTransactionRepository.js";
import { getTransactionSummary } from "../src/services/reportService.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transaction summary: one rider", () => {
  it("lists every rider for the picker, and none is chosen by default", async () => {
    const r = await getTransactionSummary({ period: "MONTHLY" } as never);

    expect(r.riderOptions.map((o) => o.name)).toEqual(["Juan Tamad", "Renen Cadungog"]);
    expect(r.rider).toBeNull();
    expect(customerTransactionRepository.findBetween).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), undefined);
  });

  it("narrows the transactions to the rider's errands", async () => {
    const r = await getTransactionSummary({ period: "MONTHLY", riderId: 3 } as never);

    expect(r.rider).toEqual({ riderId: 3, name: "Renen Cadungog" });
    expect(customerTransactionRepository.findBetween).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), 3);
  });

  it("refuses a rider who does not exist", async () => {
    await expect(getTransactionSummary({ period: "MONTHLY", riderId: 999 } as never)).rejects.toMatchObject({ status: 404 });
  });
});

describe("transaction summary: the payment proof photo", () => {
  it("carries the photo's id, so the report can open it, and null without one", async () => {
    // Owner, 2026-10-27: "In the proof from, the image shall be viewable."
    const errand = (payments: unknown[]) => ({
      referenceNo: "261022-AAAAA-0001",
      status: "DELIVERED",
      deliveryAddress: "Tacurong City",
      deliveryFee: 50,
      rider: { firstName: "Renen", lastName: "Cadungog" },
      paymentSelection: null,
      paymentMode: { name: "GCash" },
      payments,
    });
    const tx = (id: number, payments: unknown[]) => ({
      id,
      errandId: `e-${id}`,
      amount: 300,
      paymentMethod: "COD",
      status: "PENDING",
      createdAt: new Date("2026-10-22T02:00:00Z"),
      customer: { information: { firstName: "Maria", lastName: "Clara" } },
      errand: errand(payments),
    });
    vi.mocked(customerTransactionRepository.findBetween).mockResolvedValueOnce([
      tx(1, [
        {
          kind: "UPFRONT",
          amount: 300,
          confirmedBy: null,
          proofImage: { id: 77, riderId: null, customerId: 9, extraction: { referenceNo: "1012345678901", transactionId: null } },
        },
      ]),
      tx(2, []),
    ] as never);

    const r = await getTransactionSummary({ period: "MONTHLY" } as never);
    const byId = new Map(r.transactions.map((t) => [t.errandId, t]));

    expect(byId.get("e-1")).toMatchObject({ paymentProofImageId: 77, paymentEvidenceSource: "customer" });
    expect(byId.get("e-2")).toMatchObject({ paymentProofImageId: null, paymentEvidenceSource: null });
    expect(r.totals).toMatchObject({
      count: 2,
      amount: 600,
      unremitted: 0,
      uncollected: 300,
    });
  });

  it("summarises unremitted and uncollected amounts in totals", async () => {
    vi.mocked(customerTransactionRepository.findBetween).mockResolvedValueOnce([
      {
        id: 10,
        errandId: "e-short",
        amount: 500,
        paymentMethod: "COD",
        status: "PAID",
        createdAt: new Date("2026-10-22T02:00:00Z"),
        customer: { information: { firstName: "Maria", lastName: "Clara" } },
        errand: {
          referenceNo: "261022-AAAAA-0010",
          status: "COMPLETED",
          deliveryAddress: "Tacurong City",
          deliveryFee: 60,
          rider: { firstName: "Renen", lastName: "Cadungog" },
          paymentSelection: null,
          paymentMode: { name: "Cash on Delivery" },
          payments: [],
          settlement: {
            id: 1,
            expectedAmount: 500,
            collectedAmount: 420,
            variance: -80,
            adjustments: [{ kind: "RIDER_PAID_BACK", amount: 30 }],
          },
        },
      },
      {
        id: 11,
        errandId: "e-uncollected",
        amount: 250,
        paymentMethod: "COD",
        status: "PENDING",
        createdAt: new Date("2026-10-22T03:00:00Z"),
        customer: { information: { firstName: "Jose", lastName: "Rizal" } },
        errand: {
          referenceNo: "261022-AAAAA-0011",
          status: "DELIVERED",
          deliveryAddress: "Tacurong City",
          deliveryFee: 50,
          rider: { firstName: "Renen", lastName: "Cadungog" },
          paymentSelection: null,
          paymentMode: { name: "Cash on Delivery" },
          payments: [],
          settlement: null,
        },
      },
    ] as never);

    const r = await getTransactionSummary({ period: "MONTHLY" } as never);
    expect(r.totals).toMatchObject({
      count: 2,
      amount: 750,
      deliveryFee: 110,
      unremitted: 50,
      unremittedCount: 1,
      uncollected: 250,
      uncollectedCount: 1,
    });
  });
});
