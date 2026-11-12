import { beforeEach, describe, expect, it, vi } from "vitest";

// Same stubbing shape as reportAllocationReconciliation.test.ts: the report is
// exercised against fixed rows, never a live database.
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findWithSettlementBetween: vi.fn() },
}));
vi.mock("../src/repositories/settlementRepository.js", () => ({
  settlementRepository: {
    findBetweenWithRider: vi.fn(),
    findRepaymentsBetweenWithSettlement: vi.fn(async () => []),
  },
}));
vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: {
    findAllRiders: vi.fn(async () => [
      { id: 3, username: "caramel", firstName: "Renen", lastName: "Cadungog" },
      { id: 4, username: "tamad", firstName: "Juan", lastName: "Tamad" },
    ]),
  },
}));

import { errandRepository } from "../src/repositories/errandRepository.js";
import { settlementRepository } from "../src/repositories/settlementRepository.js";
import { getSettlementReport } from "../src/services/reportService.js";

interface Row {
  totalCost: number;
  deliveryFee?: number;
  estimatedCost?: number;
  tip?: number;
  settlement?: { collectedAmount: number } | null;
}

const row = (r: Row) => ({
  totalCost: r.totalCost,
  deliveryFee: r.deliveryFee ?? 70,
  estimatedCost: r.estimatedCost ?? 0,
  tip: r.tip ?? 0,
  settlement: r.settlement ?? null,
  commission: null,
});

async function report(rows: Row[]) {
  vi.mocked(errandRepository.findWithSettlementBetween).mockResolvedValue(
    rows.map(row) as never
  );
  vi.mocked(settlementRepository.findBetweenWithRider).mockResolvedValue([] as never);
  return getSettlementReport({ period: "MONTHLY" } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Gross Revenue used to be `settlement?.collectedAmount ?? totalCost` — cash a
 * rider counted and cash nobody has seen, added together with nothing saying
 * which was which.
 *
 * It matters most for non-COD, which settlementService rejects outright: such an
 * errand can never acquire a settlement, so it would sit in the headline at full
 * value for ever, indistinguishable from money in the safe.
 */
describe("gross revenue separates counted cash from priced cash", () => {
  it("puts a reconciled errand in collectedRevenue", async () => {
    const r = await report([{ totalCost: 300, settlement: { collectedAmount: 300 } }]);

    expect(r.revenue.collectedRevenue).toBe(300);
    expect(r.revenue.awaitingCollection).toBe(0);
    expect(r.revenue.awaitingCount).toBe(0);
  });

  it("puts an unreconciled errand in awaitingCollection", async () => {
    // A finished errand with no settlement behind it — a non-COD one, or a COD
    // one whose rider never settled.
    const r = await report([{ totalCost: 300 }]);

    expect(r.revenue.collectedRevenue).toBe(0);
    expect(r.revenue.awaitingCollection).toBe(300);
    expect(r.revenue.awaitingCount).toBe(1);
  });

  it("reports a short collection at what was actually collected", async () => {
    // The rider handed back ₱250 of an expected ₱300. Counted cash is ₱250; the
    // ₱50 gap is a variance, not revenue awaiting collection.
    const r = await report([{ totalCost: 300, settlement: { collectedAmount: 250 } }]);

    expect(r.revenue.collectedRevenue).toBe(250);
    expect(r.revenue.awaitingCollection).toBe(0);
  });

  it("always adds up to the headline", async () => {
    // The invariant the decomposition rests on: it explains grossRevenue rather
    // than restating it, so no existing view or CSV export changes meaning.
    const r = await report([
      { totalCost: 300, settlement: { collectedAmount: 300 } },
      { totalCost: 450, settlement: { collectedAmount: 400 } },
      { totalCost: 275 },
      { totalCost: 120 },
    ]);

    expect(r.revenue.collectedRevenue).toBe(700);
    expect(r.revenue.awaitingCollection).toBe(395);
    expect(r.revenue.grossRevenue).toBe(1095);
    expect(r.revenue.collectedRevenue! + r.revenue.awaitingCollection!).toBe(
      r.revenue.grossRevenue
    );
  });

  it("keeps the headline at the figure it has always reported", async () => {
    // What the old one-line reduce produced, for the same rows.
    const rows: Row[] = [
      { totalCost: 300, settlement: { collectedAmount: 250 } },
      { totalCost: 450 },
    ];
    const legacy = rows.reduce((s, r) => s + (r.settlement?.collectedAmount ?? r.totalCost), 0);

    expect((await report(rows)).grossRevenue).toBe(legacy);
  });

  it("mirrors the split on the flat fields the CSV exports read", async () => {
    const r = await report([{ totalCost: 300 }]);

    expect(r.collectedRevenue).toBe(r.revenue.collectedRevenue);
    expect(r.awaitingCollection).toBe(r.revenue.awaitingCollection);
  });
});

describe("the owner is told when revenue is uncounted", () => {
  it("adds a note naming the amount", async () => {
    const r = await report([{ totalCost: 275 }]);

    expect(r.notes.some((n) => n.includes("275.00") && /not been handed over/i.test(n))).toBe(true);
  });

  it("stays quiet when everything reconciled", async () => {
    const r = await report([{ totalCost: 300, settlement: { collectedAmount: 300 } }]);

    expect(r.notes.some((n) => /not been handed over/i.test(n))).toBe(false);
  });
});

describe("what happened to the shorts", () => {
  it("adds up on every line, per rider and in total: short = paid back + written off + still owed", async () => {
    vi.mocked(errandRepository.findWithSettlementBetween).mockResolvedValue([] as never);
    const handover = (id: number, riderId: number, variance: number, adjustments: Array<Record<string, unknown>>) => ({
      id,
      errandId: `e-${id}`,
      errand: { referenceNo: `ref-${id}` },
      riderId,
      expectedAmount: 500,
      collectedAmount: 500 + variance,
      variance,
      status: variance < 0 ? "SHORT" : variance > 0 ? "OVER" : "MATCHED",
      shortReason: null,
      settledAt: new Date(),
      rider: { firstName: "Rider", lastName: String(riderId) },
      adjustments: adjustments.map((a, i) => ({
        id: i + 1,
        reference: null,
        note: null,
        recordedAt: new Date(),
        recordedById: 7,
        voidedAt: null,
        recordedBy: { firstName: "Rose", lastName: "Santos", username: "rose" },
        ...a,
      })),
    });
    vi.mocked(settlementRepository.findBetweenWithRider).mockResolvedValue([
      handover(1, 3, -60, [{ kind: "RIDER_PAID_BACK", amount: 60 }]),
      handover(2, 3, -100, [
        { kind: "CUSTOMER_PAID_GCASH", amount: 30, reference: "1012345678901" },
        { kind: "WRITTEN_OFF", amount: 20 },
        { kind: "RIDER_PAID_BACK", amount: 50, voidedAt: new Date() }, // undone: ignored
      ]),
      handover(3, 4, -40, []),
      handover(4, 4, 25, []),
    ] as never);

    const r = await getSettlementReport({ period: "MONTHLY" } as never);

    for (const line of r.cash.lines) {
      expect(line.paidBackLater + line.writtenOff + line.stillOwed).toBe(line.short);
    }
    expect(r.cash).toMatchObject({ shortTotal: 200, paidBackLaterTotal: 90, writtenOffTotal: 20, stillOwedTotal: 90 });
    expect(r.cash.byRider.find((x) => x.riderId === 3)).toMatchObject({ paidBackLater: 90, writtenOff: 20, stillOwed: 50 });
    expect(r.cash.lines.find((l) => l.errandId === "e-2")?.followUps.map((f) => f.label)).toEqual([
      "Customer paid by GCash",
      "Written off",
    ]);
    // The over handover owes nothing and has nothing recorded.
    expect(r.cash.lines.find((l) => l.errandId === "e-4")).toMatchObject({ short: 0, stillOwed: 0, followUps: [] });
    // Short and over are reported apart, and still net to the old figure.
    expect(r.cash).toMatchObject({ shortTotal: 200, shortageCount: 3, overTotal: 25, overCount: 1, varianceTotal: -175 });
    // And apart per rider, per line and per period (owner, 2026-10-27: Short and
    // Over as two columns). Rider 4's -40 and +25 would net to -15 in one column.
    expect(r.cash.byRider.find((x) => x.riderId === 4)).toMatchObject({ short: 40, over: 25, variance: -15 });
    expect(r.cash.byRider.find((x) => x.riderId === 3)).toMatchObject({ short: 160, over: 0 });
    expect(r.cash.lines.find((l) => l.errandId === "e-4")).toMatchObject({ short: 0, over: 25 });
    expect(r.cash.lines.find((l) => l.errandId === "e-3")).toMatchObject({ short: 40, over: 0 });
    const points = r.timelineBreakdown;
    expect(points.reduce((sum, p) => sum + p.short, 0)).toBe(200);
    expect(points.reduce((sum, p) => sum + p.over, 0)).toBe(25);
  });
});

describe("settlement report: one rider", () => {
  beforeEach(() => {
    vi.mocked(errandRepository.findWithSettlementBetween).mockResolvedValue([] as never);
    vi.mocked(settlementRepository.findBetweenWithRider).mockResolvedValue([] as never);
  });

  it("lists every rider for the picker, and none is chosen by default", async () => {
    const r = await getSettlementReport({ period: "MONTHLY" } as never);

    expect(r.riderOptions.map((o) => o.name)).toEqual(["Juan Tamad", "Renen Cadungog"]);
    expect(r.rider).toBeNull();
    expect(settlementRepository.findBetweenWithRider).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), undefined);
  });

  it("narrows the sales and the cash to the rider", async () => {
    const r = await getSettlementReport({ period: "MONTHLY", riderId: 3 } as never);

    expect(r.rider).toEqual({ riderId: 3, name: "Renen Cadungog" });
    expect(errandRepository.findWithSettlementBetween).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), 3);
    expect(settlementRepository.findBetweenWithRider).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), 3);
  });

  it("refuses a rider who does not exist", async () => {
    await expect(getSettlementReport({ period: "MONTHLY", riderId: 999 } as never)).rejects.toMatchObject({ status: 404 });
  });

  it("includes Help Desk repayments recorded in the period as settlement transaction rows", async () => {
    vi.mocked(settlementRepository.findRepaymentsBetweenWithSettlement).mockResolvedValueOnce([
      {
        id: 501,
        settlementId: 10,
        kind: "RIDER_PAID_BACK",
        amount: 60,
        reference: null,
        note: "Paid at office",
        recordedAt: new Date("2026-10-22T05:00:00Z"),
        recordedById: 7,
        voidedAt: null,
        recordedBy: { firstName: "Rose", lastName: "Santos", username: "rose" },
        settlement: {
          id: 10,
          errandId: "e-older-short",
          errand: { referenceNo: "261020-AAAAA-0010" },
          riderId: 3,
          rider: { firstName: "Renen", lastName: "Cadungog" },
          expectedAmount: 300,
          collectedAmount: 240,
          variance: -60,
          shortReason: "Short change",
          settledAt: new Date("2026-10-20T05:00:00Z"),
          adjustments: [
            {
              id: 501,
              kind: "RIDER_PAID_BACK",
              amount: 60,
              reference: null,
              note: "Paid at office",
              recordedAt: new Date("2026-10-22T05:00:00Z"),
              recordedById: 7,
              voidedAt: null,
              recordedBy: { firstName: "Rose", lastName: "Santos", username: "rose" },
            },
          ],
        },
      },
    ] as never);

    const r = await getSettlementReport({ period: "MONTHLY" } as never);

    expect(r.cash.lines).toHaveLength(1);
    expect(r.cash.lines[0]).toMatchObject({
      lineKey: "repayment-501",
      lineKind: "REPAYMENT",
      errandId: "e-older-short",
      riderName: "Renen Cadungog",
      expected: 60,
      collected: 60,
      status: "Rider paid back",
      shortReason: "Paid at office",
      short: 0,
      over: 0,
      stillOwed: 0,
    });
    expect(r.cash.byRider.find((b) => b.riderId === 3)?.paidBackLater).toBe(60);
  });
});
