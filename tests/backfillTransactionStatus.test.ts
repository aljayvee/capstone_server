import { describe, expect, it, vi } from "vitest";
import { PAYMENT_MODE_GCASH } from "../src/services/patterns/paymentModes.js";

/**
 * The one-off backfill for customer_transactions.status. Runs the real script
 * against a mocked Prisma: what it decides to write, and that paidAt is dated
 * from the evidence (settlement or ledger row), never from the day it runs.
 */

const SETTLED_AT = new Date("2026-09-01T10:00:00Z");
const FIRST_FINAL = new Date("2026-09-02T09:00:00Z");
const LAST_FINAL = new Date("2026-09-02T11:00:00Z");
const LIVE_PAID_AT = new Date("2026-10-09T12:00:00Z");

const gcash = { paymentMode: { name: PAYMENT_MODE_GCASH } };

const { rows, updates, exited } = vi.hoisted(() => {
  let resolveExit: () => void = () => undefined;
  return {
    rows: [] as any[],
    updates: [] as any[],
    exited: { promise: new Promise<void>((r) => (resolveExit = r)), resolve: () => resolveExit() },
  };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    customerTransaction: {
      findMany: vi.fn(async () => rows),
      update: vi.fn((args: unknown) => {
        updates.push(args);
        return args;
      }),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    $disconnect: vi.fn(async () => undefined),
  },
}));

const errand = (over: Record<string, unknown>) => ({
  status: "DELIVERED",
  totalCost: 1120,
  paymentSelection: null,
  payments: [],
  settlement: null,
  ...over,
});

rows.push(
  // COD, settled in full: PAID, dated by the settlement.
  { id: 1, errandId: "cod-paid", status: "PENDING", paidAt: null, errand: errand({ settlement: { status: "MATCHED", settledAt: SETTLED_AT } }) },
  // COD, short: SHORT, and no paidAt.
  { id: 2, errandId: "cod-short", status: "PENDING", paidAt: null, errand: errand({ settlement: { status: "SHORT", settledAt: SETTLED_AT } }) },
  // GCash, two FINAL rows clearing the bill: dated by the later one.
  {
    id: 3,
    errandId: "gcash-paid",
    status: "PENDING",
    paidAt: null,
    errand: errand({
      paymentSelection: gcash,
      payments: [
        { kind: "FINAL", amount: 600, confirmedAt: FIRST_FINAL },
        { kind: "FINAL", amount: 520, confirmedAt: LAST_FINAL },
      ],
    }),
  },
  // Cancelled cash on delivery: CANCELLED.
  { id: 4, errandId: "cod-cancelled", status: "PENDING", paidAt: null, errand: errand({ status: "CANCELLED" }) },
  // Still in progress: already right, nothing written.
  { id: 5, errandId: "in-progress", status: "PENDING", paidAt: null, errand: errand({ status: "IN_TRANSIT" }) },
  // Already PAID by the live trigger: paidAt kept, nothing written.
  { id: 6, errandId: "live", status: "PAID", paidAt: LIVE_PAID_AT, errand: errand({ settlement: { status: "MATCHED", settledAt: SETTLED_AT } }) }
);

describe("backfillTransactionStatus", () => {
  it("writes only what changed, with paidAt from the evidence", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((() => {
      exited.resolve();
    }) as never);

    await import("../src/scripts/backfillTransactionStatus.js");
    await exited.promise;

    const byId = Object.fromEntries(updates.map((u) => [u.where.id, u.data]));
    expect(Object.keys(byId).map(Number).sort()).toEqual([1, 2, 3, 4]);
    expect(byId[1]).toEqual({ status: "PAID", paidAt: SETTLED_AT });
    expect(byId[2]).toEqual({ status: "SHORT" });
    expect(byId[3]).toEqual({ status: "PAID", paidAt: LAST_FINAL });
    expect(byId[4]).toEqual({ status: "CANCELLED" });
  });
});
