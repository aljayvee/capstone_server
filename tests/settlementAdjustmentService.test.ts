import { beforeEach, describe, expect, it, vi } from "vitest";

const { tx, create, findById, voidIfStanding, findShort, sync } = vi.hoisted(() => {
  const tx = {
    settlementRecord: { findUnique: vi.fn() },
    exceptionReview: { create: vi.fn() },
  };
  return {
    tx,
    create: vi.fn(),
    findById: vi.fn(),
    voidIfStanding: vi.fn(),
    findShort: vi.fn(),
    sync: vi.fn(),
  };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) },
}));
vi.mock("../src/repositories/settlementAdjustmentRepository.js", () => ({
  settlementAdjustmentRepository: {
    create,
    findById,
    voidIfStanding,
    findShortSettlementsWithAdjustments: findShort,
  },
}));
vi.mock("../src/services/transactionStatusService.js", () => ({ syncTransactionStatusQuietly: sync }));

import {
  listMoneyStillOwed,
  recordAdjustment,
  resolveCashShort,
  voidAdjustment,
} from "../src/services/settlementAdjustmentService.js";

const SHORT_60 = { id: 11, variance: -60, adjustments: [] as Array<{ kind: string; amount: number; voidedAt: Date | null }> };

beforeEach(() => {
  vi.clearAllMocks();
  tx.settlementRecord.findUnique.mockResolvedValue(SHORT_60);
  create.mockImplementation(async (data) => ({ id: 99, voidedAt: null, ...data }));
  tx.exceptionReview.create.mockImplementation(async ({ data }) => ({ id: 5, ...data }));
});

describe("recordAdjustment", () => {
  it("records a partial payment and reports what is still owed", async () => {
    const result = await recordAdjustment({ errandId: "e-1", kind: "RIDER_PAID_BACK", amount: 30, userId: 7 });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: 11, kind: "RIDER_PAID_BACK", amount: 30, recordedById: 7, reviewId: null }),
      tx
    );
    expect(result.balance.stillOwed).toBe(30);
    expect(sync).toHaveBeenCalledWith("e-1");
  });

  it("refuses more than is owed, and writes nothing", async () => {
    await expect(
      recordAdjustment({ errandId: "e-1", kind: "WRITTEN_OFF", amount: 70, userId: 7 })
    ).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
  });

  it("answers 404 when the order has no cash handover", async () => {
    tx.settlementRecord.findUnique.mockResolvedValue(null);
    await expect(
      recordAdjustment({ errandId: "e-1", kind: "RIDER_PAID_BACK", amount: 10, userId: 7 })
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("resolveCashShort", () => {
  it("saves the Help Desk decision and the money together, linked", async () => {
    const review = await resolveCashShort({
      errandId: "e-1",
      reviewerId: 7,
      reason: "  Rider paid it back on Friday  ",
      amountAtRisk: 60,
      outcome: { kind: "CUSTOMER_PAID_GCASH", amount: 60, reference: "1012345678901" },
    });

    expect(tx.exceptionReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "CASH_VARIANCE", reason: "Rider paid it back on Friday", amountAtRisk: 60 }),
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 5, kind: "CUSTOMER_PAID_GCASH", reference: "1012345678901" }),
      tx
    );
    expect(review.id).toBe(5);
  });

  it("refuses the whole thing when the money part is invalid", async () => {
    await expect(
      resolveCashShort({
        errandId: "e-1",
        reviewerId: 7,
        reason: "Customer paid by GCash",
        amountAtRisk: 60,
        outcome: { kind: "CUSTOMER_PAID_GCASH", amount: 60, reference: "" },
      })
    ).rejects.toMatchObject({ status: 400 });
    // In the real transaction the review row is rolled back with it.
    expect(create).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});

describe("voidAdjustment", () => {
  const recent = (over: Record<string, unknown> = {}) => ({
    id: 99,
    recordedById: 7,
    recordedAt: new Date(),
    voidedAt: null,
    settlement: { errandId: "e-1" },
    ...over,
  });

  it("lets the recorder undo within 10 minutes", async () => {
    findById.mockResolvedValue(recent());
    voidIfStanding.mockResolvedValue(1);

    await voidAdjustment("e-1", 99, 7);
    expect(voidIfStanding).toHaveBeenCalledWith(99, 7);
    expect(sync).toHaveBeenCalledWith("e-1");
  });

  it("refuses someone else, an old entry, one already undone, or another order's", async () => {
    findById.mockResolvedValue(recent());
    await expect(voidAdjustment("e-1", 99, 8)).rejects.toMatchObject({ status: 403 });

    findById.mockResolvedValue(recent({ recordedAt: new Date(Date.now() - 11 * 60 * 1000) }));
    await expect(voidAdjustment("e-1", 99, 7)).rejects.toMatchObject({ status: 403 });

    findById.mockResolvedValue(recent({ voidedAt: new Date() }));
    await expect(voidAdjustment("e-1", 99, 7)).rejects.toMatchObject({ status: 409 });

    findById.mockResolvedValue(recent());
    await expect(voidAdjustment("e-2", 99, 7)).rejects.toMatchObject({ status: 404 });
    expect(voidIfStanding).not.toHaveBeenCalled();
  });
});

describe("listMoneyStillOwed", () => {
  const row = (id: number, adjustments: Array<Record<string, unknown>>) => ({
    id,
    errandId: `e-${id}`,
    errand: { referenceNo: `261022-0000${id}-0001` },
    riderId: 3,
    rider: { firstName: "Renen", lastName: "Cadungog" },
    expectedAmount: 470,
    collectedAmount: 410,
    variance: -60,
    shortReason: null,
    settledAt: new Date("2026-10-20T09:00:00Z"),
    adjustments,
  });
  const entry = (over: Record<string, unknown>) => ({
    id: 1,
    kind: "RIDER_PAID_BACK",
    amount: 60,
    reference: null,
    note: null,
    recordedAt: new Date("2026-10-21T09:00:00Z"),
    recordedById: 7,
    voidedAt: null,
    recordedBy: { firstName: "Rose", lastName: "Santos", username: "rose" },
    ...over,
  });

  it("lists what is still owed, and drops a short that has been fully paid", async () => {
    findShort.mockResolvedValue([row(1, []), row(2, [entry({})]), row(3, [entry({ amount: 20 })])]);

    const owed = await listMoneyStillOwed(7);
    expect(owed.map((o) => [o.errandId, o.stillOwed, o.paidSoFar])).toEqual([
      ["e-1", 60, 0],
      ["e-3", 40, 20],
    ]);
    expect(owed[1].adjustments[0]).toMatchObject({ label: "Rider paid back", recordedBy: "Rose Santos", canUndo: false });
  });

  it("keeps a fully paid one for the 10 minutes it can still be undone", async () => {
    findShort.mockResolvedValue([row(2, [entry({ recordedAt: new Date() })])]);

    const owed = await listMoneyStillOwed(7);
    expect(owed).toHaveLength(1);
    expect(owed[0].stillOwed).toBe(0);
    expect(owed[0].adjustments[0].canUndo).toBe(true);
  });
});
