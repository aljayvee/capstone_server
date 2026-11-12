import { inflateSync } from "node:zlib";
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
const META = {
  period: "MONTHLY" as const,
  rangeLabel: "September 2026",
  coverageLabel: "2026, by month",
  start: "",
  end: "",
};
const SIGNATORY = { fullName: "Aljay Vee Versola", roleLabel: "Owner" };

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A breakdown row per day, with every figure any report's table reads. */
function points(figures: Record<string, number>) {
  return DAY_NAMES.map((label, i) => ({ label, dateLabel: `Oct ${18 + i}`, ...figures }));
}

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
    onTimeCount: 3,
    notCheckedCount: 2,
    noPromiseCount: 1,
    unverifiedCount: 1,
    degradedEtaCount: 0,
    cancellationRate: 0.1,
    reachedCount: 10,
    cancelledCount: 1,
    connectivityDrops: 2,
    unresolvedDrops: 0,
    declinedCount: 3,
    expiredOfferCount: 1,
  },
  earnings: {
    riderShareEarned: 1250.5,
    commissionCount: 12,
    settlementVarianceTotal: -25,
    // Apart: one handover PHP 60 short, others PHP 35 over in all; net -25.
    cashShortTotal: 60,
    cashOverTotal: 35,
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
    onTimeCount: 0,
    notCheckedCount: 0,
    noPromiseCount: 0,
    unverifiedCount: 0,
    degradedEtaCount: 0,
    cancellationRate: null,
    reachedCount: 0,
    cancelledCount: 0,
    connectivityDrops: 0,
    unresolvedDrops: 0,
    declinedCount: 0,
    expiredOfferCount: 0,
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
    timelineBreakdown: points({ orderCount: 1, revenue: 100, itemCost: 80, deliveryFee: 15, tip: 5 }),
    byCategory: [CATEGORY_ROW],
    reconciliation: { totalRevenue: 1000, allocatedRevenue: 1000, difference: 0 },
    uncategorisedRevenue: 0,
    notes: ["A note."],
  } as never);

  vi.mocked(reportService.getRiderPerformanceReport).mockResolvedValue({
    ...META,
    riders: [RIDER_ROW, EMPTY_RIDER],
    timelineBreakdown: points({
      completedCount: 2,
      cancelledCount: 0,
      riderShareEarned: 150,
      settlementVarianceTotal: 0,
      cashShort: 10,
      cashOver: 10,
    }),
    fleet: {
      riderCount: 2,
      completedCount: 12,
      avgDeliveryMinutes: 34.5,
      deliveryTimedCount: 11,
      onTimeRate: 0.75,
      onTimeDenominator: 4,
      notCheckedCount: 2,
      degradedEtaCount: 0,
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
    riderCommission: 105,
    totalDeliveryFees: 150,
    orderCount: 4,
    commissionRate: 0.7,
    timelineBreakdown: points({ orderCount: 1, deliveryFee: 15, businessShare: 5, riderShare: 10 }),
    byCategory: [CATEGORY_ROW],
    notes: [],
  } as never);

  vi.mocked(reportService.getSettlementReport).mockResolvedValue({
    ...META,
    commissionRate: 0.7,
    timelineBreakdown: points({ settlementCount: 1, expected: 100, collected: 95, variance: -5, short: 7, over: 2, shortageCount: 1, stillOwed: 0 }),
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
      shortTotal: 25,
      overTotal: 0,
      overCount: 0,
      paidBackLaterTotal: 25,
      writtenOffTotal: 0,
      stillOwedTotal: 0,
      byRider: [
        {
          riderId: 1,
          riderName: "Juan Dela Cruz",
          settlementCount: 2,
          expected: 1000,
          collected: 975,
          variance: -25,
          short: 25,
          over: 0,
          shortageCount: 1,
          paidBackLater: 25,
          writtenOff: 0,
          stillOwed: 0,
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
          short: 25,
          over: 0,
          paidBackLater: 25,
          writtenOff: 0,
          stillOwed: 0,
          followUps: [
            {
              kind: "RIDER_PAID_BACK",
              label: "Rider paid back",
              amount: 25,
              reference: null,
              recordedAt: "2026-10-22T00:00:00.000Z",
              recordedBy: "Rose Santos",
            },
          ],
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
    timelineBreakdown: points({ count: 1, amount: 100, deliveryFee: 15 }),
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
    timelineBreakdown: points({ count: 1, openCount: 1, resolvedCount: 0, atRisk: 30 }),
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
      printedBy: SIGNATORY,
    });

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
    // Monthly is the whole year by month since the 2026-10-18 period change, so
    // the file is named from January 1.
    expect(filename).toMatch(/^Sugo_.+_MONTHLY_2026-01-01\.pdf$/);
  });

  it("renders a rider with no recorded metrics without printing a misleading zero", async () => {
    // The empty rider in the fixture has null for every nullable metric. This
    // proves the builders reach the dash path rather than throwing on null —
    // a crash here would mean a whole fleet report fails because one rider was
    // idle for the period.
    const { buffer } = await renderReportPdf({
      reportType: "rider-performance",
      request: { period: "MONTHLY", date: REFERENCE },
      printedBy: SIGNATORY,
    });

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("reads every report from the same service the JSON endpoint uses", async () => {
    // The structural guarantee that the printout and the screen cannot diverge.
    await renderReportPdf({
      reportType: "sales",
      request: { period: "MONTHLY", date: REFERENCE },
      printedBy: SIGNATORY,
    });

    expect(reportService.getSalesReport).toHaveBeenCalledWith({ period: "MONTHLY", date: REFERENCE });
  });

  it("names files from local date parts, not UTC", async () => {
    // An export run at 9pm in Manila must not be filed under the next day.
    const evening = resolveRange({ period: "MONTHLY", date: new Date(2026, 8, 1, 21, 30) });
    expect(filenameFor("sales", evening)).toBe("Sugo_Sales_Report_MONTHLY_2026-01-01.pdf");
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

/** Every string PDFKit drew, decoded from the content streams. */
function drawnStrings(pdf: Buffer): string[] {
  let content = "";
  // Exact framing, no optional \r: see the same helper in reportPdfDocument.test.ts.
  for (const m of pdf.toString("latin1").matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    try {
      content += inflateSync(Buffer.from(m[1], "latin1")).toString("latin1") + "\n";
    } catch {
      /* fonts and other non-flate streams */
    }
  }
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("[") || !line.includes("TJ")) continue;
    let text = "";
    for (const hex of line.matchAll(/<([0-9a-fA-F]+)>/g)) text += Buffer.from(hex[1], "hex").toString("latin1");
    if (text.trim()) out.push(text);
  }
  return out;
}

const BREAKDOWN_TITLE: Record<ReportType, string> = {
  sales: "Sales per day",
  "rider-performance": "Riders' work per day",
  commission: "Sugo and Rider's earnings per day",
  settlement: "Cash collected per day",
  transactions: "Transactions per day",
  exceptions: "Problems per day",
};

describe("a Daily printout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
  });

  it.each(REPORT_TYPES)("%s opens with a Sunday to Saturday table", async (reportType) => {
    // The bug this guards: a Daily print named a date range and listed category
    // totals. The days themselves must be on the paper, in order, first.
    const { buffer } = await renderReportPdf({
      reportType,
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);

    const title = strings.indexOf(BREAKDOWN_TITLE[reportType]);
    expect(title).toBeGreaterThan(-1);

    const days = DAY_NAMES.map((d) => strings.indexOf(d));
    expect(days.every((i) => i > title)).toBe(true);
    expect([...days].sort((a, b) => a - b)).toEqual(days);

    // Nothing else titled comes before it.
    const otherTitles = strings.filter((t) =>
      /^(Sales|Earnings) by (store type|Merchant Category)$|^Cash collected by rider$|^By (payment method|order status)$|^Problems by (type|rider)$|^Every |^Work done|^Pay, cash/.test(t)
    );
    for (const other of otherTitles) expect(strings.indexOf(other)).toBeGreaterThan(title);

    expect(strings).toContain("Daily (Sunday to Saturday)");
  });

  it("signs the last page with the printer's name and role", async () => {
    const { buffer } = await renderReportPdf({
      reportType: "sales",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
      printedAt: new Date("2026-10-22T07:15:00Z"),
    });
    const strings = drawnStrings(buffer);

    expect(strings).toContain("Printed by:");
    expect(strings).toContain("ALJAY VEE VERSOLA");
    expect(strings).toContain("Owner");
    // Manila time, whatever the host clock: 07:15 UTC is 3:15 PM in Manila.
    expect(strings).toContain("Printed Oct 22, 2026, 3:15 PM");
  });

  it("names the window in words, never the period enum", async () => {
    const { buffer, coverageLabel } = await renderReportPdf({
      reportType: "sales",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });

    expect(coverageLabel).toBe(
      "This week, by day: Sunday, Oct 18, 2026 to Saturday, Oct 24, 2026"
    );
    expect(drawnStrings(buffer)).not.toContain("DAILY");
  });
});

describe("one rider's printout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
    vi.mocked(reportService.getRiderPerformanceReport).mockResolvedValue({
      ...META,
      timelineBreakdown: points({ completedCount: 1, cancelledCount: 0, riderShareEarned: 56, settlementVarianceTotal: 0, cashShort: 0, cashOver: 0 }),
      riders: [RIDER_ROW],
      fleet: { riderCount: 1, completedCount: 12, avgDeliveryMinutes: 34.5, deliveryTimedCount: 11, onTimeRate: 0.75, onTimeDenominator: 4, notCheckedCount: 2, degradedEtaCount: 0, riderShareEarned: 1250.5, settlementVarianceTotal: -25, shortageCount: 1, exceptionCount: 2, connectivityDrops: 2 },
      riderOptions: [{ riderId: 1, name: "Juan Dela Cruz" }, { riderId: 2, name: "Maria Santos" }],
      rider: { riderId: 1, name: "Juan Dela Cruz" },
      deliveries: [
        { errandId: "abcdef12-3456-7890-abcd-ef1234567890", referenceNo: "261022-67890-0001", acceptedAt: "2026-10-22T01:00:00.000Z", deliveredAt: "2026-10-22T01:42:00.000Z", promisedBy: "2026-10-22T01:30:00.000Z", check: { result: "LATE", minutesLate: 12, nearestMeters: 20 } },
        { errandId: "abcdef12-3456-7890-abcd-ef1234567891", referenceNo: "261022-67891-0002", acceptedAt: "2026-10-22T02:00:00.000Z", deliveredAt: "2026-10-22T02:20:00.000Z", promisedBy: null, check: { result: "NOT_CHECKED", reason: "FAR_FROM_ADDRESS", nearestMeters: 32325 } },
      ],
      declines: [
        { id: 2, errandId: "abcdef12-3456-7890-abcd-ef1234567892", referenceNo: "261022-67892-0003", kind: "DECLINED", reason: "Flat tyre", offeredAt: "2026-10-22T03:00:00.000Z", declinedAt: "2026-10-22T03:00:20.000Z" },
        { id: 1, errandId: "abcdef12-3456-7890-abcd-ef1234567893", referenceNo: "261022-67893-0004", kind: "EXPIRED", reason: "Offer expired with no answer from the rider", offeredAt: "2026-10-22T02:50:00.000Z", declinedAt: "2026-10-22T02:51:00.000Z" },
      ],
      notes: ["A caveat."],
    } as never);
  });

  it("lists every offer the rider declined or let lapse, with the reason they gave", async () => {
    const { buffer } = await renderReportPdf({
      reportType: "rider-performance",
      request: { period: "DAILY", date: new Date(2026, 9, 22), riderId: 1 },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);

    expect(strings).toContain("Every offer declined or let lapse in these dates");
    expect(strings).toContain("Offers declined / let lapse");
    expect(strings).toContain("3 / 1");
    expect(strings).toContain("Flat tyre");
    expect(strings).toContain("Let lapse");
  });

  it("names the rider in the header and filename, and lists every delivery without punctuality verdict", async () => {
    const { buffer, filename, subject } = await renderReportPdf({
      reportType: "rider-performance",
      request: { period: "DAILY", date: new Date(2026, 9, 22), riderId: 1 },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);

    expect(subject).toEqual({ label: "Rider", value: "Juan Dela Cruz" });
    expect(filename).toBe("Sugo_Rider_Performance_Report_Juan_Dela_Cruz_DAILY_2026-10-18.pdf");
    expect(strings).toContain("Juan Dela Cruz");
    expect(strings).toContain("Work per day");
    expect(strings).toContain("Juan Dela Cruz: all figures");
    expect(strings).toContain("Every delivery in these dates");
    expect(strings).not.toContain("Punctuality Status");
    // The fleet tables are not in a one-rider printout.
    expect(strings).not.toContain("Work done");
    expect(reportService.getRiderPerformanceReport).toHaveBeenCalledWith(
      expect.objectContaining({ riderId: 1 })
    );
  });
});

describe("the one-rider commission printout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
  });

  it("names the rider and lists each of their errands, with no Tip column", async () => {
    vi.mocked(reportService.getCommissionReport).mockResolvedValue({
      ...META,
      estimatedCommission: 30,
      riderCommission: 75,
      totalDeliveryFees: 100,
      orderCount: 2,
      commissionRate: 0.7,
      timelineBreakdown: points({ orderCount: 0, deliveryFee: 0, businessShare: 0, riderShare: 0 }),
      byCategory: [CATEGORY_ROW],
      riderOptions: [{ riderId: 3, name: "Renen Cadungog" }],
      rider: { riderId: 3, name: "Renen Cadungog" },
      orders: [
        { errandId: "e-1", referenceNo: "261022-AAAAA-0001", placedAt: "2026-10-22T02:00:00.000Z", deliveryFee: 60, tip: 5, businessShare: 18, riderShare: 47 },
        { errandId: "e-2", referenceNo: "261021-BBBBB-0002", placedAt: "2026-10-21T02:00:00.000Z", deliveryFee: 40, tip: 0, businessShare: 12, riderShare: 28 },
      ],
      notes: [],
    } as never);

    const { buffer, filename, subject } = await renderReportPdf({
      reportType: "commission",
      request: { period: "DAILY", date: new Date(2026, 9, 22), riderId: 3 },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);
    const text = strings.join(" ").replace(/\s+/g, " ");

    expect(subject).toEqual({ label: "Rider", value: "Renen Cadungog" });
    expect(filename).toContain("Renen_Cadungog");
    expect(text).toContain("Every errand Renen Cadungog delivered in these dates");
    expect(strings).toContain("261022-AAAAA-0001");
    expect(strings).toContain("PHP 75");
    expect(strings).toContain("SERVICE FEE");
    expect(text).not.toMatch(/\bTIP\b|DELIVERY FEE/);
  });

  it("words the fleet commission printout as the owner asked, with no notes", async () => {
    // Owner, 2026-10-27: "Sugo and Rider's earnings per <unit>", Errands,
    // Service fees, Merchant Category, no Total sales, no "About these numbers".
    const { buffer } = await renderReportPdf({
      reportType: "commission",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);
    const text = strings.join(" ").replace(/\s+/g, " ");

    expect(strings).toContain("Sugo and Rider's earnings per day");
    expect(strings).toContain("Earnings by Merchant Category");
    expect(strings).toContain("MERCHANT CATEGORY");
    expect(strings).toContain("ERRANDS");
    expect(strings).toContain("SERVICE FEES");
    expect(text).not.toMatch(/ORDERS|DELIVERY FEES|TOTAL SALES|STORE TYPE|\bTIP\b/);
    expect(text).not.toMatch(/ABOUT THESE NUMBERS|Tips go fully/);
  });

  it("totals the rider's share under Earnings by Merchant Category", async () => {
    // Owner, 2026-10-27: the Total row carried Sugo's share but left the
    // rider's share blank. 105 appears nowhere else on this paper (the period
    // table's rider total is 7 x 10 = 70).
    const { buffer } = await renderReportPdf({
      reportType: "commission",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);
    const tableStart = strings.indexOf("Earnings by Merchant Category");
    const after = strings.slice(tableStart);
    const totalAt = after.lastIndexOf("Total");

    expect(tableStart).toBeGreaterThan(-1);
    expect(after.slice(totalAt, totalAt + 5)).toEqual(["Total", "4", "PHP 150", "PHP 45", "PHP 105"]);
  });
});

describe("the settlement printout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
  });

  it("shows what happened to a short since the handover, and what is unremitted", async () => {
    const { buffer } = await renderReportPdf({
      reportType: "settlement",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);

    expect(strings).toContain("What happened since".toUpperCase());
    // The cell wraps, so read the drawn text as one run.
    expect(strings.join(" ").replace(/\s+/g, " ")).toContain("Rider paid back PHP 25 (Oct 22, Rose Santos)");
    expect(strings).toContain("Unremitted".toUpperCase());
    expect(strings).not.toContain("Still owed (today)".toUpperCase());
  });

  it("splits Short and Over, drops Times short and the notes, and uses the owner's words", async () => {
    // Owner, 2026-10-27: "Cash turn-over" not "Handovers", "Expected to collect"
    // not "Should collect", Short and Over as two columns, no Times short, no
    // "About these numbers". The period fixture has short 7 and over 2 per day,
    // which a single netted column (-5) could not show.
    const { buffer } = await renderReportPdf({
      reportType: "settlement",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);
    const text = strings.join(" ").replace(/\s+/g, " ");

    expect(strings).toContain("Cash collected per day");
    expect(strings).toContain("Cash collected by rider");
    expect(strings).toContain("Every cash turn-over in these dates");
    for (const header of ["CASH TURN-OVER", "EXPECTED TO COLLECT", "SHORT", "OVER"]) {
      expect(strings).toContain(header);
    }
    expect(text).not.toMatch(/SHORT OR OVER|TIMES SHORT|HANDOVERS|SHOULD COLLECT|Cash handed over/);
    expect(text).not.toMatch(/ABOUT THESE NUMBERS/);

    // The period table's Total row: 7 days of short 7 and over 2.
    const period = strings.slice(strings.indexOf("Cash collected per day"));
    const t = period.indexOf("Total");
    expect(period.slice(t, t + 7)).toEqual(["Total", "7", "PHP 700", "PHP 665", "PHP 49", "PHP 14", "PHP 0"]);

    // The rider table's Total row carries short and over apart.
    const riders = strings.slice(strings.indexOf("Cash collected by rider"));
    const rt = riders.indexOf("Total");
    expect(riders.slice(rt, rt + 6)).toEqual(["Total", "2", "PHP 1,000", "PHP 975", "PHP 25", "PHP 0"]);
  });
});

describe("the sales printout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
  });

  it("has no Tips column, even when the data carries a tip", async () => {
    // The business takes no tips; the column only ever printed PHP 0.00. The
    // fixture's tips (CATEGORY_ROW.tip 50, 5 per day) prove the column is gone
    // for good, not hidden on zero.
    const { buffer } = await renderReportPdf({
      reportType: "sales",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);

    expect(strings).not.toContain("TIPS");
    expect(strings).toContain("DELIVERY FEES");
    expect(strings).toContain("TOTAL SALES");
  });
});

describe("the rider performance printout's columns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
  });

  it("leaves cash to the Settlement report, cancellations as a count, and no On time or notes", async () => {
    // Owner's requests 2026-10-27: drop On time, Cancelled as a number,
    // "Errands Delivered", no "About these numbers"; then no cash short / cash
    // over at all, because cash handed over is the Settlement report's subject.
    const { buffer } = await renderReportPdf({
      reportType: "rider-performance",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);
    const text = strings.join(" ");

    expect(text).not.toMatch(/CASH SHORT|CASH OVER|CASH HANDOVER/i);
    // RIDER_ROW carries PHP 60 short and PHP 35 over; neither may print.
    expect(text).not.toContain("PHP 60");
    expect(text).not.toContain("PHP 35");
    expect(strings).toContain("Pay and ratings");
    expect(text).not.toMatch(/ON TIME|On time/);
    expect(text).not.toMatch(/NOT CHECKED/);
    expect(strings).toContain("ERRANDS DELIVERED");
    expect(text).not.toMatch(/ORDERS DELIVERED/);
    expect(text).not.toMatch(/CANCELLED \(OUT OF\)/);
    expect(text).not.toContain("A caveat.");
  });

  it("drops Times offline, Times short and Problems, and brackets nothing in the columns", async () => {
    // Owner's request 2026-10-27, second pass on the printout.
    const { buffer } = await renderReportPdf({
      reportType: "rider-performance",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);
    const text = strings.join(" ");

    expect(text).not.toMatch(/TIMES OFFLINE|TIMES SHORT|PROBLEMS/);
    expect(strings).toContain("ERRANDS PER HOUR ONLINE");
    expect(text).not.toMatch(/ORDERS PER HOUR ONLINE/);
    expect(strings).toContain("RATING");
    expect(text).toContain("4.6 from 40");
    // No bracket in any table: headers or cells. The header band's period name
    // ("Daily (Sunday to Saturday)") is not a column and keeps its wording.
    const tableText = text.slice(text.indexOf("Riders' work per day"));
    expect(tableText).not.toMatch(/[()]/);
  });

  it("words the one-rider figures without brackets, and leaves out offline, short and problems", async () => {
    vi.mocked(reportService.getRiderPerformanceReport).mockResolvedValue({
      ...META,
      timelineBreakdown: points({ completedCount: 1, cancelledCount: 0, riderShareEarned: 56, settlementVarianceTotal: 0, cashShort: 0, cashOver: 0 }),
      riders: [RIDER_ROW],
      fleet: { riderCount: 1, completedCount: 12 },
      riderOptions: [{ riderId: 1, name: "Juan Dela Cruz" }],
      rider: { riderId: 1, name: "Juan Dela Cruz" },
      deliveries: [],
      declines: [],
      notes: [],
    } as never);
    const { buffer } = await renderReportPdf({
      reportType: "rider-performance",
      request: { period: "DAILY", date: new Date(2026, 9, 22), riderId: 1 },
      printedBy: SIGNATORY,
    });
    const text = drawnStrings(buffer).join(" ");

    expect(text).toContain("Errands per hour online");
    expect(text).toContain("Cancelled, of errands given to them");
    expect(text).toContain("Rating, all time");
    expect(text).not.toMatch(/Times offline|times short|Problems|money involved/i);
    const tableText = text.slice(text.indexOf("Work per day"));
    expect(tableText).not.toMatch(/[()]/);
  });
});

describe("the transaction summary printout for one rider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
  });

  it("names the rider on the paper and in the filename", async () => {
    // Owner, 2026-10-27: the Transaction Summary gained the rider picker the
    // Settlement and Commission reports have, so its printout says whose it is.
    const base = await reportService.getTransactionSummary({} as never);
    vi.mocked(reportService.getTransactionSummary).mockResolvedValueOnce({
      ...(base as object),
      riderOptions: [{ riderId: 3, name: "Renen Cadungog" }],
      rider: { riderId: 3, name: "Renen Cadungog" },
    } as never);

    const { buffer, filename, subject } = await renderReportPdf({
      reportType: "transactions",
      request: { period: "DAILY", date: new Date(2026, 9, 22), riderId: 3 },
      printedBy: SIGNATORY,
    });

    expect(subject).toEqual({ label: "Rider", value: "Renen Cadungog" });
    expect(filename).toContain("Renen_Cadungog");
    expect(drawnStrings(buffer)).toContain("Renen Cadungog");
  });
});

describe("the transaction summary printout's wording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
  });

  it("says Service fee, not Delivery fee, and has no notes", async () => {
    // Owner, 2026-10-27: "Rephrase the Delivery Fee to Service fee" and remove
    // "About these numbers", even when the data still carries a note.
    const base = await reportService.getTransactionSummary({} as never);
    vi.mocked(reportService.getTransactionSummary).mockResolvedValueOnce({
      ...(base as object),
      notes: ["Payment status is saved once, when the order is placed."],
    } as never);

    const { buffer } = await renderReportPdf({
      reportType: "transactions",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);
    const text = strings.join(" ").replace(/\s+/g, " ");

    expect(strings).toContain("SERVICE FEES");
    expect(strings).toContain("UNREMITTED");
    expect(strings).toContain("UNCOLLECTED");
    expect(text).not.toMatch(/DELIVERY FEE|Delivery fee/);
    expect(text).not.toMatch(/ABOUT THESE NUMBERS|Payment status is saved once/);
  });
});

describe("the help desk printout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubAll();
  });

  it("prints only who cleared a problem, a whole-number rate, cash short apart, and Errand not Order", async () => {
    // Owner, 2026-10-27: no dispatcher's note in Status, Per order as an
    // integer, "Order" -> "Errand", cash short and over separated.
    const base = (await reportService.getExceptionReport({} as never)) as never as Record<string, unknown> & {
      exceptions: Array<Record<string, unknown>>;
    };
    vi.mocked(reportService.getExceptionReport).mockResolvedValueOnce({
      ...base,
      exceptions: [
        {
          ...base.exceptions[0],
          problem: "CASH_SHORT",
          resolvedAt: "2026-09-02T10:00:00.000Z",
          resolvedBy: "Rose Santos",
          resolutionReason: "Rider paid it back at the counter",
        },
      ],
      summary: { openCount: 0, resolvedCount: 1, totalAtRisk: 300, byKind: [{ kind: "CASH_SHORT", count: 1, atRisk: 300 }] },
    } as never);

    const { buffer } = await renderReportPdf({
      reportType: "exceptions",
      request: { period: "DAILY", date: new Date(2026, 9, 22) },
      printedBy: SIGNATORY,
    });
    const strings = drawnStrings(buffer);
    const text = strings.join(" ").replace(/\s+/g, " ");

    expect(text).toContain("Cleared by Rose Santos");
    expect(text).not.toContain("Rider paid it back at the counter");
    expect(strings).toContain("PER 100 ERRANDS");
    expect(strings).toContain("8"); // rate 0.08 -> 8 per 100 errands
    expect(text).not.toContain("0.08");
    expect(strings).toContain("ERRANDS");
    expect(strings).toContain("ERRAND");
    expect(strings).toContain("Cash short");
    expect(text).not.toMatch(/\bORDERS?\b|\bPer order\b|\border\b|Cash short or over/i);
  });
});
