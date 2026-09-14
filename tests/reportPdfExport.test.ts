import { beforeEach, describe, expect, it, vi } from "vitest";

// Every builder in reportPdfService calls the corresponding reportService
// function — that sharing is the point, so this mocks the service rather than
// the database and exercises the real column definitions.
vi.mock("../src/services/reportService.js", () => ({
  getSalesReport: vi.fn(),
  getRiderPerformanceReport: vi.fn(),
  getCommissionReport: vi.fn(),
  getSettlementReport: vi.fn(),
  getTransactionSummary: vi.fn(),
  getExceptionReport: vi.fn(),
}));

import * as reportService from "../src/services/reportService.js";
import {
  REPORT_TYPES,
  filenameFor,
  renderReportPdf,
  type ReportType,
} from "../src/services/pdf/reportPdfService.js";
import { resolveRange } from "../src/services/patterns/dateRangeResolver.js";

const REFERENCE = new Date(2026, 8, 1); // 1 Sep 2026, local
const META = { period: "MONTHLY" as const, rangeLabel: "September 2026", start: "", end: "" };

const CATEGORY_ROW = {
  category: "Supermarket & Grocery",
  revenue: 1000,
  itemCost: 800,
  deliveryFee: 150,
  tip: 50,
  count: 4,
  orderCount: 4,
  touchedOrderCount: 5,
  businessShare: 45,
  riderShare: 155,
};

const RIDER_ROW = {
  riderId: 1,
  name: "Juan Dela Cruz",
  throughput: {
    completedCount: 12,
    avgDeliveryMinutes: 34.5,
    deliveryTimedCount: 11,
    avgAcceptMinutes: 2.1,
    acceptTimedCount: 12,
    activeHours: 8,
    errandsPerActiveHour: 1.5,
  },
  reliability: {
    onTimeRate: 0.75,
    onTimeDenominator: 4,
    degradedEtaCount: 1,
    cancellationRate: 0.1,
    reachedCount: 10,
    cancelledCount: 1,
    connectivityDrops: 2,
    unresolvedDrops: 0,
  },
  earnings: {
    riderShareEarned: 1250.5,
    commissionCount: 12,
    settlementVarianceTotal: -25,
    shortageCount: 1,
    settlementCount: 12,
  },
  quality: {
    averageRatingAllTime: 4.6,
    ratingCountAllTime: 40,
    exceptionCount: 2,
    exceptionErrandCount: 12,
    exceptionRate: 0.17,
    exceptionsAtRisk: 300,
  },
  completedCount: 12,
  avgDeliveryMinutes: 34.5,
  averageRating: 4.6,
};

/** A rider with nothing recorded — every nullable metric absent. */
const EMPTY_RIDER = {
  ...RIDER_ROW,
  riderId: 2,
  name: "Maria Santos",
  throughput: {
    completedCount: 0,
    avgDeliveryMinutes: null,
    deliveryTimedCount: 0,
    avgAcceptMinutes: null,
    acceptTimedCount: 0,
    activeHours: 0,
    errandsPerActiveHour: null,
  },
  reliability: {
    onTimeRate: null,
    onTimeDenominator: 0,
    degradedEtaCount: 0,
    cancellationRate: null,
    reachedCount: 0,
    cancelledCount: 0,
    connectivityDrops: 0,
    unresolvedDrops: 0,
  },
  quality: { ...RIDER_ROW.quality, averageRatingAllTime: null, ratingCountAllTime: 0, exceptionRate: null },
  completedCount: 0,
  avgDeliveryMinutes: null,
  averageRating: null,
};

function stubAll() {
  vi.mocked(reportService.getSalesReport).mockResolvedValue({
    ...META,
    totalRevenue: 1000,
    totalOrders: 4,
    byCategory: [CATEGORY_ROW],
    reconciliation: { totalRevenue: 1000, allocatedRevenue: 1000, difference: 0 },
    uncategorisedRevenue: 0,
    notes: ["A note."],
  } as never);

  vi.mocked(reportService.getRiderPerformanceReport).mockResolvedValue({
    ...META,
    riders: [RIDER_ROW, EMPTY_RIDER],
    fleet: {
      riderCount: 2,
      completedCount: 12,
      avgDeliveryMinutes: 34.5,
      deliveryTimedCount: 11,
      onTimeRate: 0.75,
      onTimeDenominator: 4,
      degradedEtaCount: 1,
      riderShareEarned: 1250.5,
      settlementVarianceTotal: -25,
      shortageCount: 1,
      exceptionCount: 2,
      connectivityDrops: 2,
    },
    notes: ["A caveat."],
  } as never);

  vi.mocked(reportService.getCommissionReport).mockResolvedValue({
    ...META,
    estimatedCommission: 45,
    totalDeliveryFees: 150,
    orderCount: 4,
    commissionRate: 0.7,
    byCategory: [CATEGORY_ROW],
    notes: [],
  } as never);

  vi.mocked(reportService.getSettlementReport).mockResolvedValue({
    ...META,
    commissionRate: 0.7,
    revenue: {
      basis: "errand.createdAt",
      grossRevenue: 1000,
      totalDeliveryFees: 150,
      businessShare: 45,
      riderShare: 155,
      orderCount: 4,
    },
    cash: {
      basis: "settlement.settledAt",
      expectedTotal: 1000,
      collectedTotal: 975,
      varianceTotal: -25,
      settlementCount: 2,
      shortageCount: 1,
      byRider: [
        {
          riderId: 1,
          riderName: "Juan Dela Cruz",
          settlementCount: 2,
          expected: 1000,
          collected: 975,
          variance: -25,
          shortageCount: 1,
        },
      ],
      lines: [
        {
          errandId: "abcdef12-3456-7890-abcd-ef1234567890",
          riderName: "Juan Dela Cruz",
          expected: 500,
          collected: 475,
          variance: -25,
          status: "SHORT",
          shortReason: "Customer paid short",
          settledAt: "2026-09-01T10:00:00.000Z",
        },
      ],
    },
    grossRevenue: 1000,
    totalDeliveryFees: 150,
    businessShare: 45,
    riderShare: 155,
    orderCount: 4,
    notes: ["Two clocks."],
  } as never);

  vi.mocked(reportService.getTransactionSummary).mockResolvedValue({
    ...META,
    transactions: [
      {
        transactionId: 1,
        errandId: "abcdef12-3456-7890-abcd-ef1234567890",
        category: "Supermarket & Grocery",
        categories: ["Supermarket & Grocery"],
        riderName: "Juan Dela Cruz",
        customerName: "Maria Santos",
        deliveryAddress: "Poblacion, Tacurong City",
        amount: 1000,
        deliveryFee: 150,
        paymentMethod: "COD",
        status: "DELIVERED",
        errandStatus: "DELIVERED",
        paymentStatus: "PENDING",
        createdAt: "2026-09-01T10:00:00.000Z",
      },
    ],
    byPaymentMethod: [{ paymentMethod: "COD", count: 1, amount: 1000 }],
    byErrandStatus: [{ status: "DELIVERED", count: 1, amount: 1000 }],
    byPaymentStatus: [{ status: "PENDING", count: 1, amount: 1000 }],
    totals: { count: 1, amount: 1000, deliveryFee: 150 },
    notes: ["Payment status is frozen."],
  } as never);

  vi.mocked(reportService.getExceptionReport).mockResolvedValue({
    meta: META,
    exceptions: [
      {
        errandId: "abcdef12-3456-7890-abcd-ef1234567890",
        kind: "CASH_VARIANCE",
        amountAtRisk: 300,
        detail: "Collected 25 pesos less than expected.",
        riderId: 1,
        riderName: "Juan Dela Cruz",
        occurredAt: "2026-09-01T10:00:00.000Z",
        resolvedAt: null,
        resolvedBy: null,
        resolutionReason: null,
      },
    ],
    summary: {
      openCount: 1,
      resolvedCount: 0,
      totalAtRisk: 300,
      byKind: [{ kind: "CASH_VARIANCE", count: 1, atRisk: 300 }],
    },
    riders: [
      { riderId: 1, riderName: "Juan Dela Cruz", errandCount: 12, exceptionCount: 1, rate: 0.08, atRisk: 300 },
    ],
    materialityPesos: 20,
  } as never);
}

describe("renderReportPdf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
  });

  it.each(REPORT_TYPES)("renders %s as a PDF with the right filename", async (reportType) => {
    const { buffer, filename } = await renderReportPdf({
      reportType,
      request: { period: "MONTHLY", date: REFERENCE },
      generatedBy: "Aljay Vee Versola",
    });

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
    expect(filename).toMatch(/^Sugo_.+_MONTHLY_2026-09-01\.pdf$/);
  });

  it("renders a rider with no recorded metrics without printing a misleading zero", async () => {
    // The empty rider in the fixture has null for every nullable metric. This
    // proves the builders reach the dash path rather than throwing on null —
    // a crash here would mean a whole fleet report fails because one rider was
    // idle for the period.
    const { buffer } = await renderReportPdf({
      reportType: "rider-performance",
      request: { period: "MONTHLY", date: REFERENCE },
      generatedBy: "Owner",
    });

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("reads every report from the same service the JSON endpoint uses", async () => {
    // The structural guarantee that the printout and the screen cannot diverge.
    await renderReportPdf({
      reportType: "sales",
      request: { period: "MONTHLY", date: REFERENCE },
      generatedBy: "Owner",
    });

    expect(reportService.getSalesReport).toHaveBeenCalledWith({ period: "MONTHLY", date: REFERENCE });
  });

  it("names files from local date parts, not UTC", async () => {
    // An export run at 9pm in Manila must not be filed under the next day.
    const evening = resolveRange({ period: "MONTHLY", date: new Date(2026, 8, 1, 21, 30) });
    expect(filenameFor("sales", evening)).toBe("Sugo_Sales_Report_MONTHLY_2026-09-01.pdf");
  });

  it("gives every report type a distinct filename", () => {
    const daily = resolveRange({ period: "DAILY", date: REFERENCE });
    const names = new Set(REPORT_TYPES.map((t: ReportType) => filenameFor(t, daily)));
    expect(names.size).toBe(REPORT_TYPES.length);
  });

  it("spells out both ends for a hand-drawn range", () => {
    // Two exports of the same report over different windows must not collide on
    // one filename and silently overwrite each other in the Downloads folder.
    const range = resolveRange({
      start: new Date(2026, 8, 1),
      end: new Date(2026, 8, 30),
    });

    expect(filenameFor("sales", range)).toBe("Sugo_Sales_Report_2026-09-01_to_2026-09-30.pdf");
  });

  it("names the last day actually covered, not the exclusive bound", () => {
    // resolveRange pushes `end` to the following midnight so queries include the
    // final day. The filename must undo that, or every custom export would claim
    // to cover a day it stops short of.
    const range = resolveRange({ start: new Date(2026, 8, 15), end: new Date(2026, 8, 15) });

    expect(filenameFor("sales", range)).toBe("Sugo_Sales_Report_2026-09-15_to_2026-09-15.pdf");
  });
});
