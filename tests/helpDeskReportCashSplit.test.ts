import { describe, expect, it, vi } from "vitest";

// The Help Desk Report counts cash short and cash over apart (owner,
// 2026-10-27). findExceptions is stubbed: only the report's split is under test,
// and the dispatcher's queue, which shares findExceptions, keeps CASH_VARIANCE.
vi.mock("../src/services/exceptionService.js", () => ({ findExceptions: vi.fn() }));

import * as exceptionService from "../src/services/exceptionService.js";
import { getExceptionReport } from "../src/services/reportService.js";

const line = (errandId: string, kind: string, amountAtRisk: number, cash?: { expected: number; collected: number }) => ({
  errandId,
  kind,
  amountAtRisk,
  detail: "",
  riderId: 1,
  riderName: "Juan Dela Cruz",
  occurredAt: new Date("2026-10-08T03:00:00Z"),
  orderPlacedAt: new Date("2026-10-08T02:00:00Z"),
  ...(cash ? { cash: { ...cash, short: Math.max(0, cash.expected - cash.collected), stillOwed: 0 } } : {}),
  resolvedAt: null,
  resolvedBy: null,
  resolutionReason: null,
});

describe("help desk report: cash short and cash over", () => {
  it("counts them as two problems, in CASH_VARIANCE's place, short first", async () => {
    const exceptions = [
      line("e-1", "STALLED_STOP", 0),
      line("e-2", "CASH_VARIANCE", 60, { expected: 500, collected: 440 }),
      line("e-3", "CASH_VARIANCE", 25, { expected: 500, collected: 525 }),
      line("e-4", "CASH_VARIANCE", 40, { expected: 300, collected: 260 }),
      line("e-5", "MISSING_RECEIPT", 0),
    ];
    vi.mocked(exceptionService.findExceptions).mockResolvedValue({
      exceptions,
      summary: {
        openCount: 5,
        resolvedCount: 0,
        totalAtRisk: 125,
        byKind: [
          { kind: "CASH_VARIANCE", count: 3, atRisk: 125 },
          { kind: "STALLED_STOP", count: 1, atRisk: 0 },
          { kind: "MISSING_RECEIPT", count: 1, atRisk: 0 },
        ],
      },
      riders: [],
      materialityPesos: 20,
    } as never);

    const r = await getExceptionReport({ period: "MONTHLY", date: new Date(2026, 9, 27) } as never);

    expect(r.summary.byKind).toEqual([
      { kind: "CASH_SHORT", count: 2, atRisk: 100 },
      { kind: "CASH_OVER", count: 1, atRisk: 25 },
      { kind: "STALLED_STOP", count: 1, atRisk: 0 },
      { kind: "MISSING_RECEIPT", count: 1, atRisk: 0 },
    ]);
    expect(r.exceptions.map((e) => [e.errandId, e.kind, e.problem])).toEqual([
      ["e-1", "STALLED_STOP", "STALLED_STOP"],
      ["e-2", "CASH_VARIANCE", "CASH_SHORT"],
      ["e-3", "CASH_VARIANCE", "CASH_OVER"],
      ["e-4", "CASH_VARIANCE", "CASH_SHORT"],
      ["e-5", "MISSING_RECEIPT", "MISSING_RECEIPT"],
    ]);
    // The totals the split came from are unchanged.
    expect(r.summary).toMatchObject({ openCount: 5, resolvedCount: 0, totalAtRisk: 125 });
  });
});
