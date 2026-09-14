import { beforeEach, describe, expect, it, vi } from "vitest";

// Same stubbing shape as reportAllocationReconciliation.test.ts: the report is
// exercised against fixed rows, never a live database.
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findWithSettlementBetween: vi.fn() },
}));
vi.mock("../src/repositories/settlementRepository.js", () => ({
  settlementRepository: { findBetweenWithRider: vi.fn() },
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

    expect(r.notes.some((n) => n.includes("275.00") && /never reconciled/i.test(n))).toBe(true);
  });

  it("stays quiet when everything reconciled", async () => {
    const r = await report([{ totalCost: 300, settlement: { collectedAmount: 300 } }]);

    expect(r.notes.some((n) => /never reconciled/i.test(n))).toBe(false);
  });
});
