import * as reportService from "../reportService.js";
import { formatPesoAscii } from "../../lib/formatPeso.js";
import {
  erase,
  renderReportDocument,
  type ReportColumn,
  type ReportDocumentSpec,
} from "./reportDocument.js";
import type { ReportRequest } from "../reportService.js";
import { resolveRange, type ResolvedRange } from "../patterns/dateRangeResolver.js";

export const REPORT_TYPES = [
  "sales",
  "rider-performance",
  "commission",
  "settlement",
  "transactions",
  "exceptions",
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

const REPORT_NAMES: Record<ReportType, string> = {
  sales: "Sales Report",
  "rider-performance": "Rider Performance Report",
  commission: "Commission Report",
  settlement: "Settlement Report",
  transactions: "Transaction Summary",
  exceptions: "Exception Report",
};

export interface RenderReportPdfInput {
  reportType: ReportType;
  /** The same window request the JSON endpoint received. */
  request: ReportRequest;
  generatedBy: string;
}

/**
 * Builds one report as a PDF.
 *
 * **Every builder below calls the same reportService function the JSON endpoint
 * calls.** That is the only thing guaranteeing the printed figure and the figure
 * on screen agree; a second query path here would drift the first time either
 * side changed, and the divergence would surface as an owner holding a printout
 * that contradicts their dashboard with no way to tell which is wrong.
 */
export async function renderReportPdf(
  input: RenderReportPdfInput
): Promise<{ buffer: Buffer; filename: string }> {
  const spec = await buildSpec(input);
  const buffer = await renderReportDocument(spec);
  return { buffer, filename: filenameFor(input.reportType, resolveRange(input.request)) };
}

/**
 * `Sugo_Sales_Report_MONTHLY_2026-09-01.pdf`, or for a hand-drawn range
 * `Sugo_Sales_Report_2026-09-01_to_2026-09-30.pdf`.
 *
 * Mirrors the naming the CSV exports already used, so a folder holding both
 * sorts together rather than interleaving two conventions. A custom range spells
 * out both ends: two exports of the same report over different windows must not
 * land on the same filename and silently overwrite each other in Downloads.
 */
export function filenameFor(reportType: ReportType, resolved: ResolvedRange): string {
  const name = REPORT_NAMES[reportType].replace(/\s+/g, "_");

  if (resolved.period === "CUSTOM") {
    // `end` is exclusive internally; the filename names the last day actually
    // covered, matching what the range label on the document itself says.
    const lastDay = new Date(resolved.end.getTime() - 86_400_000);
    return `Sugo_${name}_${toIsoDate(resolved.start)}_to_${toIsoDate(lastDay)}.pdf`;
  }

  return `Sugo_${name}_${resolved.period}_${toIsoDate(resolved.start)}.pdf`;
}

function toIsoDate(date: Date): string {
  // Local date parts, not toISOString: the window was resolved in local time,
  // and a UTC filename would name the wrong day for evening exports.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function buildSpec(input: RenderReportPdfInput): Promise<ReportDocumentSpec> {
  const { reportType, request, generatedBy } = input;
  const resolved = resolveRange(request);

  const base = {
    reportName: REPORT_NAMES[reportType],
    // Names the window the reader is holding: a preset by name, or CUSTOM when
    // they drew their own range on the calendar.
    periodLabel: resolved.period === "CUSTOM" ? "Custom range" : resolved.period,
    generatedAt: new Date(),
    generatedBy,
  };

  // A switch rather than a lookup table: each builder is typed against its own
  // report's shape, which a Record<ReportType, (d: any) => Spec> could not do
  // without `any` (AGENTS.md 5.3).
  switch (reportType) {
    case "sales":
      return { ...base, ...(await salesSpec(request)) };
    case "rider-performance":
      return { ...base, ...(await riderPerformanceSpec(request)) };
    case "commission":
      return { ...base, ...(await commissionSpec(request)) };
    case "settlement":
      return { ...base, ...(await settlementSpec(request)) };
    case "transactions":
      return { ...base, ...(await transactionsSpec(request)) };
    case "exceptions":
      return { ...base, ...(await exceptionsSpec(request)) };
  }
}

/**
 * Builds one table, typed against its own row shape, and hands it to the layout
 * with that type erased — so a single document can hold tables of different
 * shapes without any builder below losing its checking.
 */
function table<Row>(t: {
  title?: string;
  columns: ReportColumn<Row>[];
  rows: Row[];
  totals?: Array<string | null>;
}) {
  return erase(t);
}

const dash = (v: number | null, render: (n: number) => string) => (v === null ? "—" : render(v));
const pct = (v: number | null) => dash(v, (n) => `${(n * 100).toFixed(1)}%`);
const mins = (v: number | null) => dash(v, (n) => `${n.toFixed(1)} min`);

// ── sales ──────────────────────────────────────────────────────────────────

async function salesSpec(request: ReportRequest) {
  const data = await reportService.getSalesReport(request);
  type Row = (typeof data.byCategory)[number];

  return {
    rangeLabel: data.rangeLabel,
    summary: [
      { label: "Total revenue", value: formatPesoAscii(data.totalRevenue) },
      { label: "Total orders", value: String(data.totalOrders) },
      { label: "Categories", value: String(data.byCategory.length) },
    ],
    tables: [
      table<Row>({
        columns: [
          { header: "Merchant category", width: 150, value: (r) => r.category },
          { header: "Orders", width: 55, align: "right", value: (r) => String(r.orderCount) },
          { header: "Item cost", width: 80, align: "right", value: (r) => formatPesoAscii(r.itemCost) },
          {
            header: "Delivery fees",
            width: 85,
            align: "right",
            value: (r) => formatPesoAscii(r.deliveryFee),
          },
          { header: "Tips", width: 65, align: "right", value: (r) => formatPesoAscii(r.tip) },
          { header: "Revenue", width: 85, align: "right", value: (r) => formatPesoAscii(r.revenue) },
        ],
        rows: data.byCategory,
        totals: [
          "Total",
          String(data.totalOrders),
          null,
          null,
          null,
          formatPesoAscii(data.totalRevenue),
        ],
      }),
    ],
    notes: [
      ...data.notes,
      reconciliationNote(data.reconciliation.difference),
    ],
  };
}

/**
 * Says out loud whether the category column adds up to the headline.
 *
 * Printed rather than asserted internally: if allocation ever stops
 * reconciling, whoever is holding the paper sees it, instead of an auditor
 * finding it months later.
 */
function reconciliationNote(difference: number): string {
  return difference === 0
    ? "Category revenue reconciles exactly to the total above."
    : `WARNING: category revenue is out by ${formatPesoAscii(difference)} against the total above. ` +
        `Treat this report as provisional and report the discrepancy.`;
}

// ── rider performance ──────────────────────────────────────────────────────

async function riderPerformanceSpec(request: ReportRequest) {
  const data = await reportService.getRiderPerformanceReport(request);
  type Row = (typeof data.riders)[number];

  // Two tables rather than one: twelve metrics across Letter portrait would set
  // each column too narrow to read. They share a document, a letterhead and one
  // footer sequence, so this is still one report in one format.
  return {
    rangeLabel: data.rangeLabel,
    summary: [
      { label: "Riders", value: String(data.fleet.riderCount) },
      { label: "Completed", value: String(data.fleet.completedCount) },
      { label: "Avg delivery", value: mins(data.fleet.avgDeliveryMinutes) },
      { label: "On time", value: pct(data.fleet.onTimeRate) },
      { label: "Rider earnings", value: formatPesoAscii(data.fleet.riderShareEarned) },
    ],
    tables: [
      table<Row>({
        title: "Throughput and reliability",
        columns: [
          { header: "Rider", width: 118, value: (r) => r.name },
          {
            header: "Completed",
            width: 62,
            align: "right",
            value: (r) => String(r.throughput.completedCount),
          },
          {
            header: "Avg delivery",
            width: 68,
            align: "right",
            value: (r) => mins(r.throughput.avgDeliveryMinutes),
          },
          {
            header: "Avg to accept",
            width: 68,
            align: "right",
            value: (r) => mins(r.throughput.avgAcceptMinutes),
          },
          {
            header: "Per active hr",
            width: 66,
            align: "right",
            value: (r) => dash(r.throughput.errandsPerActiveHour, (n) => n.toFixed(2)),
          },
          {
            // The denominator travels with the rate. "75%" and "75% of the 4
            // errands that carried an ETA" support different decisions.
            header: "On time (of n)",
            width: 78,
            align: "right",
            value: (r) =>
              r.reliability.onTimeRate === null
                ? "—"
                : `${pct(r.reliability.onTimeRate)} (${r.reliability.onTimeDenominator})`,
          },
          {
            header: "Drops",
            width: 60,
            align: "right",
            value: (r) => String(r.reliability.connectivityDrops),
          },
        ],
        rows: data.riders,
      }),
      table<Row>({
        title: "Earnings and service quality",
        columns: [
          { header: "Rider", width: 118, value: (r) => r.name },
          {
            header: "Earned",
            width: 78,
            align: "right",
            value: (r) => formatPesoAscii(r.earnings.riderShareEarned),
          },
          {
            header: "Cash variance",
            width: 82,
            align: "right",
            value: (r) => formatPesoAscii(r.earnings.settlementVarianceTotal),
          },
          {
            header: "Short",
            width: 50,
            align: "right",
            value: (r) => String(r.earnings.shortageCount),
          },
          {
            header: "Cancelled",
            width: 66,
            align: "right",
            value: (r) =>
              r.reliability.cancellationRate === null
                ? "—"
                : `${pct(r.reliability.cancellationRate)} (${r.reliability.reachedCount})`,
          },
          {
            // Count beside the mean, so one 5-star rating cannot outrank forty.
            header: "Rating (of n)",
            width: 68,
            align: "right",
            value: (r) =>
              r.quality.averageRatingAllTime === null
                ? "Not yet rated"
                : `${r.quality.averageRatingAllTime.toFixed(1)} (${r.quality.ratingCountAllTime})`,
          },
          {
            header: "Exceptions",
            width: 58,
            align: "right",
            value: (r) => String(r.quality.exceptionCount),
          },
        ],
        rows: data.riders,
      }),
    ],
    notes: data.notes,
  };
}

// ── commission ─────────────────────────────────────────────────────────────

async function commissionSpec(request: ReportRequest) {
  const data = await reportService.getCommissionReport(request);
  type Row = (typeof data.byCategory)[number];

  const businessPct = Math.round((1 - data.commissionRate) * 100);

  return {
    rangeLabel: data.rangeLabel,
    summary: [
      { label: "Estimated commission", value: formatPesoAscii(data.estimatedCommission) },
      { label: "Delivery fees", value: formatPesoAscii(data.totalDeliveryFees) },
      { label: "Orders", value: String(data.orderCount) },
    ],
    tables: [
      table<Row>({
        columns: [
          { header: "Merchant category", width: 150, value: (r) => r.category },
          { header: "Orders", width: 55, align: "right", value: (r) => String(r.orderCount) },
          { header: "Revenue", width: 85, align: "right", value: (r) => formatPesoAscii(r.revenue) },
          {
            header: "Delivery fees",
            width: 85,
            align: "right",
            value: (r) => formatPesoAscii(r.deliveryFee),
          },
          {
            header: "Business share",
            width: 80,
            align: "right",
            value: (r) => formatPesoAscii(r.businessShare),
          },
          {
            header: "Rider share",
            width: 65,
            align: "right",
            value: (r) => formatPesoAscii(r.riderShare),
          },
        ],
        rows: data.byCategory,
        totals: [
          "Total",
          String(data.orderCount),
          null,
          formatPesoAscii(data.totalDeliveryFees),
          formatPesoAscii(data.estimatedCommission),
          null,
        ],
      }),
    ],
    notes: [
      ...data.notes,
      `The split is taken on delivery fees only — ${businessPct}% to the business, ` +
        `${Math.round(data.commissionRate * 100)}% to the rider, with the whole tip passing to ` +
        `the rider. Money fronted for the goods is never split.`,
    ],
  };
}

// ── settlement ─────────────────────────────────────────────────────────────

async function settlementSpec(request: ReportRequest) {
  const data = await reportService.getSettlementReport(request);
  type RiderRow = (typeof data.cash.byRider)[number];
  type LineRow = (typeof data.cash.lines)[number];

  return {
    rangeLabel: data.rangeLabel,
    summary: [
      { label: "Gross revenue", value: formatPesoAscii(data.revenue.grossRevenue) },
      { label: "Business share", value: formatPesoAscii(data.revenue.businessShare) },
      { label: "Rider share", value: formatPesoAscii(data.revenue.riderShare) },
      { label: "Cash collected", value: formatPesoAscii(data.cash.collectedTotal) },
      { label: "Variance", value: formatPesoAscii(data.cash.varianceTotal) },
    ],
    tables: [
      table<RiderRow>({
        // The basis is in the title because these lines are windowed on when
        // cash was settled while the revenue tiles above are windowed on when
        // errands were placed. Unlabelled, the gap reads as missing money.
        title: "Cash reconciled by rider (by settlement date)",
        columns: [
          { header: "Rider", width: 150, value: (r) => r.riderName ?? `Rider ${r.riderId}` },
          {
            header: "Settlements",
            width: 70,
            align: "right",
            value: (r) => String(r.settlementCount),
          },
          { header: "Expected", width: 85, align: "right", value: (r) => formatPesoAscii(r.expected) },
          {
            header: "Collected",
            width: 85,
            align: "right",
            value: (r) => formatPesoAscii(r.collected),
          },
          { header: "Variance", width: 75, align: "right", value: (r) => formatPesoAscii(r.variance) },
          { header: "Short", width: 55, align: "right", value: (r) => String(r.shortageCount) },
        ],
        rows: data.cash.byRider,
        totals: [
          "Total",
          String(data.cash.settlementCount),
          formatPesoAscii(data.cash.expectedTotal),
          formatPesoAscii(data.cash.collectedTotal),
          formatPesoAscii(data.cash.varianceTotal),
          String(data.cash.shortageCount),
        ],
      }),
      table<LineRow>({
        title: "Every settlement in this period",
        columns: [
          { header: "Errand", width: 80, value: (r) => r.errandId.slice(0, 8) },
          { header: "Rider", width: 105, value: (r) => r.riderName ?? "—" },
          { header: "Expected", width: 72, align: "right", value: (r) => formatPesoAscii(r.expected) },
          {
            header: "Collected",
            width: 72,
            align: "right",
            value: (r) => formatPesoAscii(r.collected),
          },
          { header: "Variance", width: 68, align: "right", value: (r) => formatPesoAscii(r.variance) },
          { header: "Status", width: 55, value: (r) => r.status },
          { header: "Reason", width: 68, value: (r) => r.shortReason ?? "" },
        ],
        rows: data.cash.lines,
      }),
    ],
    notes: data.notes,
  };
}

// ── transactions ───────────────────────────────────────────────────────────

async function transactionsSpec(request: ReportRequest) {
  const data = await reportService.getTransactionSummary(request);
  type Row = (typeof data.transactions)[number];
  type MethodRow = (typeof data.byPaymentMethod)[number];

  return {
    rangeLabel: data.rangeLabel,
    summary: [
      { label: "Transactions", value: String(data.totals.count) },
      { label: "Total amount", value: formatPesoAscii(data.totals.amount) },
      { label: "Delivery fees", value: formatPesoAscii(data.totals.deliveryFee) },
    ],
    tables: [
      table<MethodRow>({
        title: "By payment method",
        columns: [
          { header: "Payment method", width: 260, value: (r) => r.paymentMethod },
          { header: "Transactions", width: 130, align: "right", value: (r) => String(r.count) },
          { header: "Amount", width: 130, align: "right", value: (r) => formatPesoAscii(r.amount) },
        ],
        rows: data.byPaymentMethod,
        totals: ["Total", String(data.totals.count), formatPesoAscii(data.totals.amount)],
      }),
      table<(typeof data.byErrandStatus)[number]>({
        title: "By errand status",
        columns: [
          { header: "Status", width: 260, value: (r) => r.status },
          { header: "Transactions", width: 130, align: "right", value: (r) => String(r.count) },
          { header: "Amount", width: 130, align: "right", value: (r) => formatPesoAscii(r.amount) },
        ],
        rows: data.byErrandStatus,
      }),
      table<Row>({
        title: "Every transaction in this period",
        columns: [
          { header: "Errand", width: 58, value: (r) => r.errandId.slice(0, 8) },
          { header: "Category", width: 92, value: (r) => r.category },
          { header: "Rider", width: 74, value: (r) => r.riderName ?? "Unassigned" },
          { header: "Customer", width: 74, value: (r) => r.customerName ?? "—" },
          { header: "Amount", width: 66, align: "right", value: (r) => formatPesoAscii(r.amount) },
          {
            header: "Delivery fee",
            width: 62,
            align: "right",
            value: (r) => formatPesoAscii(r.deliveryFee),
          },
          { header: "Payment", width: 44, value: (r) => r.paymentMethod },
          // Full status, not an abbreviation: DELIVERED, COMPLETED and
          // CANCELLED are indistinguishable at three characters.
          { header: "Status", width: 50, value: (r) => r.errandStatus },
        ],
        rows: data.transactions,
        totals: [
          "Total",
          null,
          null,
          null,
          formatPesoAscii(data.totals.amount),
          formatPesoAscii(data.totals.deliveryFee),
          null,
          null,
        ],
      }),
    ],
    notes: data.notes,
  };
}

// ── exceptions ─────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  CASH_VARIANCE: "Cash variance",
  RECEIPT_DIVERGENCE: "Receipt divergence",
  UNVERIFIED_PURCHASE: "Unverified purchase",
  WRONG_BRANCH: "Wrong branch",
  MISSING_RECEIPT: "No receipt at a stop",
  STALLED_STOP: "Long stop",
};

async function exceptionsSpec(request: ReportRequest) {
  const data = await reportService.getExceptionReport(request);
  type KindRow = (typeof data.summary.byKind)[number];
  type RiderRow = (typeof data.riders)[number];
  type ExceptionRow = (typeof data.exceptions)[number];

  return {
    rangeLabel: data.meta.rangeLabel,
    summary: [
      { label: "Still open", value: String(data.summary.openCount) },
      { label: "Cleared", value: String(data.summary.resolvedCount) },
      { label: "Total at risk", value: formatPesoAscii(data.summary.totalAtRisk) },
    ],
    tables: [
      table<KindRow>({
        title: "What went wrong",
        columns: [
          { header: "Kind", width: 260, value: (r) => KIND_LABEL[r.kind] ?? r.kind },
          { header: "Count", width: 130, align: "right", value: (r) => String(r.count) },
          {
            header: "At risk",
            width: 130,
            align: "right",
            value: (r) => (r.atRisk > 0 ? formatPesoAscii(r.atRisk) : "—"),
          },
        ],
        rows: data.summary.byKind,
      }),
      table<RiderRow>({
        title: "By rider",
        columns: [
          { header: "Rider", width: 160, value: (r) => r.riderName ?? `Rider ${r.riderId}` },
          { header: "Errands", width: 80, align: "right", value: (r) => String(r.errandCount) },
          { header: "Exceptions", width: 90, align: "right", value: (r) => String(r.exceptionCount) },
          { header: "Per errand", width: 90, align: "right", value: (r) => r.rate.toFixed(2) },
          {
            header: "At risk",
            width: 100,
            align: "right",
            value: (r) => (r.atRisk > 0 ? formatPesoAscii(r.atRisk) : "—"),
          },
        ],
        rows: data.riders,
      }),
      table<ExceptionRow>({
        title: "Every exception in this period",
        columns: [
          { header: "Errand", width: 62, value: (r) => r.errandId.slice(0, 8) },
          { header: "Kind", width: 96, value: (r) => KIND_LABEL[r.kind] ?? r.kind },
          {
            header: "At risk",
            width: 62,
            align: "right",
            value: (r) => (r.amountAtRisk > 0 ? formatPesoAscii(r.amountAtRisk) : "—"),
          },
          { header: "Rider", width: 76, value: (r) => r.riderName ?? "—" },
          { header: "What happened", width: 134, value: (r) => r.detail },
          {
            header: "Status",
            width: 90,
            value: (r) =>
              r.resolvedAt ? `Cleared by ${r.resolvedBy ?? "—"}: ${r.resolutionReason ?? ""}` : "Open",
          },
        ],
        rows: data.exceptions,
      }),
    ],
    notes: [
      `Amounts below ${formatPesoAscii(data.materialityPesos)} are not raised as exceptions.`,
      "Cleared exceptions are kept deliberately — who cleared one and what they said is the " +
        "part that carries weight in a dispute.",
    ],
  };
}
