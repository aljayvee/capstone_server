import * as reportService from "../reportService.js";
import { formatPesoAscii } from "../../lib/formatPeso.js";
import { referenceKey } from "../../lib/errandReference.js";
import {
  erase,
  renderReportDocument,
  type ReportColumn,
  type ReportDocumentSpec,
  type ReportSignatory,
} from "./reportDocument.js";
import type { ReportRequest } from "../reportService.js";
import { resolveRange, type ResolvedRange } from "../patterns/dateRangeResolver.js";
import {
  PERIOD_NAMES,
  breakdownTitle,
  describeCoverage,
  periodBuckets,
  type BucketUnit,
} from "../patterns/periodBuckets.js";

export const REPORT_TYPES = [
  "sales",
  "rider-performance",
  "commission",
  "settlement",
  "transactions",
  "exceptions",
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

// The names the Owner portal's tabs use, so the paper says what the button said.
export const REPORT_NAMES: Record<ReportType, string> = {
  sales: "Sales Report",
  "rider-performance": "Rider Performance Report",
  commission: "Commission Report",
  settlement: "Settlement Report",
  transactions: "Transaction Summary",
  exceptions: "Help Desk Report",
};

export interface RenderReportPdfInput {
  reportType: ReportType;
  /** The same window request the JSON endpoint received. */
  request: ReportRequest;
  printedBy: ReportSignatory;
  /** Defaults to now. Passed in so the audit row and the paper carry one instant. */
  printedAt?: Date;
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
): Promise<{
  buffer: Buffer;
  filename: string;
  resolved: ResolvedRange;
  coverageLabel: string;
  subject: { label: string; value: string } | null;
}> {
  const resolved = resolveRange(input.request);
  const spec = await buildSpec(input, resolved);
  const buffer = await renderReportDocument(spec);
  return {
    buffer,
    filename: filenameFor(input.reportType, resolved, spec.subject?.value),
    resolved,
    coverageLabel: spec.coverageLabel,
    subject: spec.subject ?? null,
  };
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
export function filenameFor(reportType: ReportType, resolved: ResolvedRange, subject?: string): string {
  // One rider's report carries their name, so two riders' printouts of the
  // same week do not save over each other.
  const who = subject ? `_${subject.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}` : "";
  const name = REPORT_NAMES[reportType].replace(/\s+/g, "_") + who;

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

async function buildSpec(
  input: RenderReportPdfInput,
  resolved: ResolvedRange
): Promise<ReportDocumentSpec> {
  const { reportType, request, printedBy } = input;
  const unit = periodBuckets(resolved.period, resolved.start, resolved.end).unit;

  const base = {
    reportName: REPORT_NAMES[reportType],
    // The window in words: "Daily (Sunday to Saturday)", never the enum.
    periodName: PERIOD_NAMES[resolved.period],
    coverageLabel: describeCoverage(resolved),
    printedAt: input.printedAt ?? new Date(),
    printedBy,
  };

  // A switch rather than a lookup table: each builder is typed against its own
  // report's shape, which a Record<ReportType, (d: any) => Spec> could not do
  // without `any` (AGENTS.md 5.3).
  switch (reportType) {
    case "sales":
      return { ...base, ...(await salesSpec(request, unit)) };
    case "rider-performance":
      return { ...base, ...(await riderPerformanceSpec(request, unit)) };
    case "commission":
      return { ...base, ...(await commissionSpec(request, unit)) };
    case "settlement":
      return { ...base, ...(await settlementSpec(request, unit)) };
    case "transactions":
      return { ...base, ...(await transactionsSpec(request, unit)) };
    case "exceptions":
      return { ...base, ...(await exceptionsSpec(request, unit)) };
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

const UNIT_HEADER: Record<BucketUnit, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
};

/**
 * The period breakdown every report opens with: one row per day (Sunday to
 * Saturday), week, month or year, then a Total row. The two leading columns
 * are shared; each report supplies its figures.
 */
function periodTable<Row extends { label: string; dateLabel: string }>(
  subject: string,
  unit: BucketUnit,
  rows: Row[],
  figures: Array<ReportColumn<Row> & { total: string }>
) {
  return table<Row>({
    title: breakdownTitle(subject, unit),
    columns: [
      { header: UNIT_HEADER[unit], width: 105, value: (r) => r.label },
      { header: "Dates", width: 105, value: (r) => r.dateLabel },
      ...figures.map(({ total: _total, ...column }) => column),
    ],
    rows,
    totals: ["Total", null, ...figures.map((f) => f.total)],
  });
}

const sum = <Row>(rows: Row[], pick: (r: Row) => number) =>
  Math.round(rows.reduce((total, r) => total + pick(r), 0) * 100) / 100;

const dash = (v: number | null, render: (n: number) => string) => (v === null ? "-" : render(v));
const pct = (v: number | null) => dash(v, (n) => `${(n * 100).toFixed(1)}%`);
const mins = (v: number | null) => dash(v, (n) => `${n.toFixed(1)} min`);

/** DELIVERED -> Delivered, IN_TRANSIT -> In transit. */
function plainStatus(raw: string): string {
  const words = raw.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ── sales ──────────────────────────────────────────────────────────────────

async function salesSpec(request: ReportRequest, unit: BucketUnit) {
  const data = await reportService.getSalesReport(request);
  type Row = (typeof data.byCategory)[number];
  type Point = (typeof data.timelineBreakdown)[number];
  const points = data.timelineBreakdown;
  // No Tips column, as in the portal's SalesReportView: the business takes no
  // tips, and Total sales leaves `tip` out (reportService salesValue), so each
  // row is items plus delivery fee. Widths are proportional, so the other
  // columns widen to fill.

  return {
    rangeLabel: data.rangeLabel,
    summary: [
      { label: "Total sales", value: formatPesoAscii(data.totalRevenue) },
      { label: "Orders", value: String(data.totalOrders) },
      { label: "Store types", value: String(data.byCategory.length) },
    ],
    tables: [
      periodTable<Point>("Sales", unit, points, [
        { header: "Orders", width: 60, align: "right", value: (r) => String(r.orderCount), total: String(sum(points, (r) => r.orderCount)) },
        { header: "Cost of items bought", width: 110, align: "right", value: (r) => formatPesoAscii(r.itemCost), total: formatPesoAscii(sum(points, (r) => r.itemCost)) },
        { header: "Delivery fees", width: 95, align: "right", value: (r) => formatPesoAscii(r.deliveryFee), total: formatPesoAscii(sum(points, (r) => r.deliveryFee)) },
        { header: "Total sales", width: 100, align: "right", value: (r) => formatPesoAscii(r.revenue), total: formatPesoAscii(sum(points, (r) => r.revenue)) },
      ]),
      table<Row>({
        title: "Sales by store type",
        columns: [
          { header: "Store type", width: 210, value: (r) => r.category },
          { header: "Orders", width: 60, align: "right", value: (r) => String(r.orderCount) },
          { header: "Cost of items bought", width: 110, align: "right", value: (r) => formatPesoAscii(r.itemCost) },
          { header: "Delivery fees", width: 95, align: "right", value: (r) => formatPesoAscii(r.deliveryFee) },
          { header: "Total sales", width: 100, align: "right", value: (r) => formatPesoAscii(r.revenue) },
        ],
        rows: data.byCategory,
        totals: [
          "Total",
          String(data.totalOrders),
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
 * Says out loud whether the store-type column adds up to the headline.
 *
 * Printed rather than asserted internally: if allocation ever stops
 * reconciling, whoever is holding the paper sees it, instead of an auditor
 * finding it months later.
 */
function reconciliationNote(difference: number): string {
  return difference === 0
    ? "The store type amounts add up exactly to the total sales."
    : `WARNING: the store type amounts are off by ${formatPesoAscii(difference)} from the total ` +
        `sales. Treat this report as unconfirmed and report the difference.`;
}

// ── rider performance ──────────────────────────────────────────────────────

async function riderPerformanceSpec(request: ReportRequest, unit: BucketUnit) {
  const data = await reportService.getRiderPerformanceReport(request);
  if (data.rider) return oneRiderSpec(data, unit);
  type Row = (typeof data.riders)[number];
  type Point = (typeof data.timelineBreakdown)[number];
  const points = data.timelineBreakdown;

  // Two rider tables rather than one: twelve figures side by side would set
  // each column too narrow to read. They share a document, a letterhead and
  // one footer sequence, so this is still one report in one format.
  return {
    rangeLabel: data.rangeLabel,
    summary: [
      { label: "Riders", value: String(data.fleet.riderCount) },
      { label: "Errands Delivered", value: String(data.fleet.completedCount) },
      { label: "Average delivery time", value: mins(data.fleet.avgDeliveryMinutes) },
      { label: "Rider pay", value: formatPesoAscii(data.fleet.riderShareEarned) },
    ],
    tables: [
      periodTable<Point>("Riders' work", unit, points, [
        { header: "Errands Delivered", width: 95, align: "right", value: (r) => String(r.completedCount), total: String(sum(points, (r) => r.completedCount)) },
        { header: "Cancelled", width: 80, align: "right", value: (r) => String(r.cancelledCount), total: String(sum(points, (r) => r.cancelledCount)) },
        { header: "Rider pay", width: 100, align: "right", value: (r) => formatPesoAscii(r.riderShareEarned), total: formatPesoAscii(sum(points, (r) => r.riderShareEarned)) },
        // No cash short / cash over here: cash handovers belong to the
        // Settlement report (owner, 2026-10-27).
      ]),
      table<Row>({
        title: "Work done",
        columns: [
          { header: "Rider", width: 150, value: (r) => r.name },
          {
            header: "Delivered",
            width: 70,
            align: "right",
            value: (r) => String(r.throughput.completedCount),
          },
          {
            header: "Avg delivery time",
            width: 90,
            align: "right",
            value: (r) => mins(r.throughput.avgDeliveryMinutes),
          },
          {
            header: "Avg time to accept",
            width: 90,
            align: "right",
            value: (r) => mins(r.throughput.avgAcceptMinutes),
          },
          {
            header: "Errands per hour online",
            width: 100,
            align: "right",
            value: (r) => dash(r.throughput.errandsPerActiveHour, (n) => n.toFixed(2)),
          },
        ],
        rows: data.riders,
      }),
      table<Row>({
        title: "Pay and ratings",
        columns: [
          { header: "Rider", width: 150, value: (r) => r.name },
          {
            header: "Pay",
            width: 90,
            align: "right",
            value: (r) => formatPesoAscii(r.earnings.riderShareEarned),
          },
          {
            header: "Cancelled",
            width: 70,
            align: "right",
            value: (r) => String(r.reliability.cancelledCount),
          },
          {
            header: "Declined / lapsed",
            width: 80,
            align: "right",
            value: (r) => `${r.reliability.declinedCount} / ${r.reliability.expiredOfferCount}`,
          },
          {
            // Count beside the mean, so one 5-star rating cannot outrank forty.
            // Worded, not bracketed (owner, 2026-10-27).
            header: "Rating",
            width: 90,
            align: "right",
            value: (r) =>
              r.quality.averageRatingAllTime === null
                ? "Not rated yet"
                : `${r.quality.averageRatingAllTime.toFixed(1)} from ${r.quality.ratingCountAllTime}`,
          },
        ],
        rows: data.riders,
      }),
    ],
    // No "About these numbers" block on the rider printouts (owner, 2026-10-27).
    notes: [] as string[],
  };
}

const NOT_CHECKED_REASON: Record<string, string> = {
  NO_PROMISE: "Unverified: no target deadline set",
  PROMISE_TOO_LATE: "Unverified: deadline set too late into trip",
  PROMISE_TOO_CLOSE: "Unverified: deadline set at doorstep (< 2 min)",
  TIME_DOES_NOT_ADD_UP: "Unverified: delivery timestamp does not add up",
  NO_GPS_AT_DELIVERY: "Unverified: missing GPS proof at address",
  FAR_FROM_ADDRESS: "Unverified: marked delivered away from address",
};

/** "On time", "Late by 12 min", "Unverified: marked delivered 32.3 km from address". */
export function deliveryResultLabel(
  check: { result: string; minutesLate?: number; reason?: string; nearestMeters?: number | null } | null
): string {
  if (!check) return "-";
  if (check.result === "ON_TIME") return "On time";
  if (check.result === "LATE") return `Late by ${check.minutesLate} min`;
  if (check.reason === "FAR_FROM_ADDRESS" && typeof check.nearestMeters === "number") {
    const far = check.nearestMeters >= 1000
      ? `${(check.nearestMeters / 1000).toFixed(1)} km`
      : `${Math.round(check.nearestMeters)} m`;
    return `Unverified: marked delivered ${far} from address`;
  }
  return NOT_CHECKED_REASON[check.reason ?? ""] ?? "Unverified";
}

/** "Oct 22, 3:15 PM", Philippine time. */
function shortStamp(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * One rider's report: who, a full list of their figures, their work per day,
 * and every delivery with its On Time verdict.
 *
 * Same figures as the fleet report (one reportService call, narrowed to this
 * rider), laid out for one person: twelve columns of a single row would be the
 * fleet table with eleven rows missing.
 */
function oneRiderSpec(
  data: Awaited<ReturnType<typeof reportService.getRiderPerformanceReport>>,
  unit: BucketUnit
) {
  type Point = (typeof data.timelineBreakdown)[number];
  type Delivery = (typeof data.deliveries)[number];
  type Decline = (typeof data.declines)[number];
  const points = data.timelineBreakdown;
  const r = data.riders[0];
  const name = data.rider?.name ?? r?.name ?? "Rider";

  const measures: Array<{ measure: string; value: string }> = r
    ? [
        { measure: "Errands Delivered", value: String(r.throughput.completedCount) },
        // Worded, not bracketed; no times offline, times short or problems on the
        // rider printouts (owner, 2026-10-27).
        { measure: "Average delivery time, accepted to delivered", value: mins(r.throughput.avgDeliveryMinutes) },
        { measure: "Average time to accept an errand", value: mins(r.throughput.avgAcceptMinutes) },
        { measure: "Hours online", value: `${r.throughput.activeHours.toFixed(1)} h` },
        {
          measure: "Errands per hour online",
          value: dash(r.throughput.errandsPerActiveHour, (n) => n.toFixed(2)),
        },
        {
          measure: "Cancelled, of errands given to them",
          value: `${r.reliability.cancelledCount} of ${r.reliability.reachedCount}`,
        },
        {
          measure: "Offers declined / let lapse",
          value: `${r.reliability.declinedCount} / ${r.reliability.expiredOfferCount}`,
        },
        { measure: "Pay", value: formatPesoAscii(r.earnings.riderShareEarned) },
        {
          measure: "Rating, all time",
          value:
            r.quality.averageRatingAllTime === null
              ? "Not rated yet"
              : `${r.quality.averageRatingAllTime.toFixed(1)} from ${r.quality.ratingCountAllTime} ratings`,
        },
      ]
    : [];

  return {
    rangeLabel: data.rangeLabel,
    subject: { label: "Rider", value: name },
    summary: [
      { label: "Errands Delivered", value: String(r?.throughput.completedCount ?? 0) },
      { label: "Average delivery time", value: mins(r?.throughput.avgDeliveryMinutes ?? null) },
      { label: "Pay", value: formatPesoAscii(r?.earnings.riderShareEarned ?? 0) },
      {
        label: "Rating",
        value:
          !r || r.quality.averageRatingAllTime === null
            ? "Not rated yet"
            : `${r.quality.averageRatingAllTime.toFixed(1)} from ${r.quality.ratingCountAllTime}`,
      },
    ],
    tables: [
      periodTable<Point>("Work", unit, points, [
        { header: "Errands Delivered", width: 95, align: "right", value: (p) => String(p.completedCount), total: String(sum(points, (p) => p.completedCount)) },
        { header: "Cancelled", width: 80, align: "right", value: (p) => String(p.cancelledCount), total: String(sum(points, (p) => p.cancelledCount)) },
        { header: "Pay", width: 100, align: "right", value: (p) => formatPesoAscii(p.riderShareEarned), total: formatPesoAscii(sum(points, (p) => p.riderShareEarned)) },
      ]),
      table<{ measure: string; value: string }>({
        title: `${name}: all figures`,
        columns: [
          { header: "Measure", width: 360, value: (m) => m.measure },
          { header: "Value", width: 360, value: (m) => m.value },
        ],
        rows: measures,
      }),
      table<Delivery>({
        title: "Every delivery in these dates",
        columns: [
          { header: "Order", width: 210, value: (d) => d.referenceNo ?? referenceKey(d.errandId) },
          { header: "Accepted", width: 170, value: (d) => shortStamp(d.acceptedAt) },
          { header: "Delivered", width: 170, value: (d) => shortStamp(d.deliveredAt) },
          { header: "Target Deadline", width: 170, value: (d) => shortStamp(d.promisedBy) },
        ],
        rows: data.deliveries,
      }),
      table<Decline>({
        title: "Every offer declined or let lapse in these dates",
        columns: [
          { header: "Order", width: 130, value: (d) => d.referenceNo ?? referenceKey(d.errandId) },
          { header: "Offered", width: 110, value: (d) => shortStamp(d.offeredAt) },
          { header: "Turned down", width: 110, value: (d) => shortStamp(d.declinedAt) },
          { header: "How", width: 80, value: (d) => (d.kind === "EXPIRED" ? "Let lapse" : "Declined") },
          { header: "Reason given", width: 290, value: (d) => (d.kind === "EXPIRED" ? "-" : d.reason ?? "-") },
        ],
        rows: data.declines,
      }),
    ],
    notes: [] as string[],
  };
}

// ── commission ─────────────────────────────────────────────────────────────

async function commissionSpec(request: ReportRequest, unit: BucketUnit) {
  const data = await reportService.getCommissionReport(request);
  type Row = (typeof data.byCategory)[number];
  type Point = (typeof data.timelineBreakdown)[number];
  type Order = (typeof data.orders)[number];
  const points = data.timelineBreakdown;

  // Owner, 2026-10-27: "Errands" not "Orders", "Service fees" not "Delivery
  // fees", "Merchant Category" not "Store type", no Tip or Total sales column,
  // no "About these numbers" block.
  // One rider: their errands, one line each, after the merchant category table.
  const orderTables = data.rider
    ? [
        table<Order>({
          title: `Every errand ${data.rider.name} delivered in these dates`,
          columns: [
            { header: "Errand", width: 150, value: (o) => o.referenceNo ?? referenceKey(o.errandId) },
            { header: "Placed", width: 120, value: (o) => shortStamp(o.placedAt) },
            { header: "Service fee", width: 110, align: "right", value: (o) => formatPesoAscii(o.deliveryFee) },
            { header: "Sugo's share", width: 110, align: "right", value: (o) => formatPesoAscii(o.businessShare) },
            { header: "Rider's share", width: 110, align: "right", value: (o) => formatPesoAscii(o.riderShare) },
          ],
          rows: data.orders,
          totals: [
            "Total",
            null,
            formatPesoAscii(sum(data.orders, (o) => o.deliveryFee)),
            formatPesoAscii(sum(data.orders, (o) => o.businessShare)),
            formatPesoAscii(sum(data.orders, (o) => o.riderShare)),
          ],
        }),
      ]
    : [];

  return {
    rangeLabel: data.rangeLabel,
    ...(data.rider ? { subject: { label: "Rider", value: data.rider.name } } : {}),
    summary: [
      { label: "Sugo's earnings (estimate)", value: formatPesoAscii(data.estimatedCommission) },
      { label: "Service fees", value: formatPesoAscii(data.totalDeliveryFees) },
      { label: "Errands", value: String(data.orderCount) },
    ],
    tables: [
      periodTable<Point>("Sugo and Rider's earnings", unit, points, [
        { header: "Errands", width: 70, align: "right", value: (r) => String(r.orderCount), total: String(sum(points, (r) => r.orderCount)) },
        { header: "Service fees", width: 105, align: "right", value: (r) => formatPesoAscii(r.deliveryFee), total: formatPesoAscii(sum(points, (r) => r.deliveryFee)) },
        { header: "Sugo's share", width: 105, align: "right", value: (r) => formatPesoAscii(r.businessShare), total: formatPesoAscii(sum(points, (r) => r.businessShare)) },
        { header: "Rider's share", width: 105, align: "right", value: (r) => formatPesoAscii(r.riderShare), total: formatPesoAscii(sum(points, (r) => r.riderShare)) },
      ]),
      table<Row>({
        title: "Earnings by Merchant Category",
        columns: [
          { header: "Merchant Category", width: 210, value: (r) => r.category },
          { header: "Errands", width: 65, align: "right", value: (r) => String(r.orderCount) },
          {
            header: "Service fees",
            width: 100,
            align: "right",
            value: (r) => formatPesoAscii(r.deliveryFee),
          },
          {
            header: "Sugo's share",
            width: 100,
            align: "right",
            value: (r) => formatPesoAscii(r.businessShare),
          },
          {
            header: "Rider's share",
            width: 100,
            align: "right",
            value: (r) => formatPesoAscii(r.riderShare),
          },
        ],
        rows: data.byCategory,
        totals: [
          "Total",
          String(data.orderCount),
          formatPesoAscii(data.totalDeliveryFees),
          formatPesoAscii(data.estimatedCommission),
          // Owner, 2026-10-27: the rider's share gets its overall total too.
          formatPesoAscii(data.riderCommission),
        ],
      }),
      ...orderTables,
    ],
    notes: [] as string[],
  };
}

// ── settlement ─────────────────────────────────────────────────────────────

async function settlementSpec(request: ReportRequest, unit: BucketUnit) {
  const data = await reportService.getSettlementReport(request);
  type RiderRow = (typeof data.cash.byRider)[number];
  type LineRow = (typeof data.cash.lines)[number];
  type Point = (typeof data.timelineBreakdown)[number];
  const points = data.timelineBreakdown;

  return {
    rangeLabel: data.rangeLabel,
    ...(data.rider ? { subject: { label: "Rider", value: data.rider.name } } : {}),
    summary: [
      { label: "Total sales", value: formatPesoAscii(data.revenue.grossRevenue) },
      { label: "Sugo's share", value: formatPesoAscii(data.revenue.businessShare) },
      { label: "Rider's share", value: formatPesoAscii(data.revenue.riderShare) },
      { label: "Cash collected", value: formatPesoAscii(data.cash.collectedTotal) },
      { label: "Over", value: formatPesoAscii(data.cash.overTotal) },
      { label: "Unremitted", value: formatPesoAscii(data.cash.stillOwedTotal) },
    ],
    tables: [
      // Owner, 2026-10-27: "Cash turn-over" not "Handovers", "Expected to
      // collect" not "Should collect", Short and Over as two columns, no
      // Times short, no "About these numbers" block.
      periodTable<Point>("Cash collected", unit, points, [
        { header: "Cash turn-over", width: 80, align: "right", value: (r) => String(r.settlementCount), total: String(sum(points, (r) => r.settlementCount)) },
        { header: "Expected to collect", width: 100, align: "right", value: (r) => formatPesoAscii(r.expected), total: formatPesoAscii(sum(points, (r) => r.expected)) },
        { header: "Collected", width: 95, align: "right", value: (r) => formatPesoAscii(r.collected), total: formatPesoAscii(sum(points, (r) => r.collected)) },
        { header: "Short", width: 80, align: "right", value: (r) => formatPesoAscii(r.short), total: formatPesoAscii(sum(points, (r) => r.short)) },
        { header: "Over", width: 80, align: "right", value: (r) => formatPesoAscii(r.over), total: formatPesoAscii(sum(points, (r) => r.over)) },
        { header: "Unremitted", width: 85, align: "right", value: (r) => formatPesoAscii(r.stillOwed), total: formatPesoAscii(sum(points, (r) => r.stillOwed)) },
      ]),
      table<RiderRow>({
        title: "Cash collected by rider",
        columns: [
          { header: "Rider", width: 170, value: (r) => r.riderName ?? `Rider ${r.riderId}` },
          {
            // Wide enough to stay on one line: wrapped at the hyphen, "OVER"
            // lands under "CASH TURN-" and reads as a second Over column.
            header: "Cash turn-over",
            width: 115,
            align: "right",
            value: (r) => String(r.settlementCount),
          },
          { header: "Expected to collect", width: 105, align: "right", value: (r) => formatPesoAscii(r.expected) },
          {
            header: "Collected",
            width: 100,
            align: "right",
            value: (r) => formatPesoAscii(r.collected),
          },
          { header: "Short", width: 85, align: "right", value: (r) => formatPesoAscii(r.short) },
          { header: "Over", width: 85, align: "right", value: (r) => formatPesoAscii(r.over) },
          { header: "Paid back later", width: 100, align: "right", value: (r) => formatPesoAscii(r.paidBackLater) },
          { header: "Written off", width: 90, align: "right", value: (r) => formatPesoAscii(r.writtenOff) },
          { header: "Unremitted", width: 90, align: "right", value: (r) => formatPesoAscii(r.stillOwed) },
        ],
        rows: data.cash.byRider,
        totals: [
          "Total",
          String(data.cash.settlementCount),
          formatPesoAscii(data.cash.expectedTotal),
          formatPesoAscii(data.cash.collectedTotal),
          formatPesoAscii(data.cash.shortTotal),
          formatPesoAscii(data.cash.overTotal),
          formatPesoAscii(data.cash.paidBackLaterTotal),
          formatPesoAscii(data.cash.writtenOffTotal),
          formatPesoAscii(data.cash.stillOwedTotal),
        ],
      }),
      table<LineRow>({
        title: "Every cash turn-over in these dates",
        columns: [
          { header: "Order", width: 120, value: (r) => r.referenceNo ?? referenceKey(r.errandId) },
          { header: "Rider", width: 125, value: (r) => r.riderName ?? "-" },
          { header: "Expected to collect", width: 95, align: "right", value: (r) => formatPesoAscii(r.expected) },
          {
            header: "Collected",
            width: 85,
            align: "right",
            value: (r) => formatPesoAscii(r.collected),
          },
          { header: "Short", width: 75, align: "right", value: (r) => formatPesoAscii(r.short) },
          { header: "Over", width: 75, align: "right", value: (r) => formatPesoAscii(r.over) },
          { header: "Rider's note", width: 115, value: (r) => r.shortReason ?? "" },
          { header: "What happened since", width: 165, value: (r) => whatHappenedSince(r) },
          { header: "Unremitted", width: 75, align: "right", value: (r) => (r.short > 0 ? formatPesoAscii(r.stillOwed) : "") },
        ],
        rows: data.cash.lines,
      }),
    ],
    notes: [] as string[],
  };
}

/**
 * "Rider paid back PHP 60 (Oct 22, Rose Santos)", separated by semicolons, or "Not paid
 * yet" for a short nothing has been recorded against. Blank when not short and
 * not a repayment row.
 */
function whatHappenedSince(line: {
  short: number;
  stillOwed: number;
  followUps: Array<{ label: string; amount: number; recordedAt: string; recordedBy: string; reference: string | null }>;
}): string {
  if (line.short <= 0 && line.followUps.length === 0) return "";
  if (line.followUps.length === 0) return "Not paid yet";
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric" });
  return line.followUps
    .map(
      (f) =>
        `${f.label} ${formatPesoAscii(f.amount)} (${day(f.recordedAt)}, ${f.recordedBy}` +
        (f.reference ? `, ref ${f.reference}` : "") +
        ")"
    )
    .join("; ");
}

// ── transactions ───────────────────────────────────────────────────────────

async function transactionsSpec(request: ReportRequest, unit: BucketUnit) {
  const data = await reportService.getTransactionSummary(request);
  type Row = (typeof data.transactions)[number];
  type MethodRow = (typeof data.byPaymentMethod)[number];
  type Point = (typeof data.timelineBreakdown)[number];
  const points = data.timelineBreakdown;

  return {
    rangeLabel: data.rangeLabel,
    ...(data.rider ? { subject: { label: "Rider", value: data.rider.name } } : {}),
    summary: [
      { label: "Transactions", value: String(data.totals.count) },
      { label: "Total amount", value: formatPesoAscii(data.totals.amount) },
      { label: "Service fees", value: formatPesoAscii(data.totals.deliveryFee) },
      { label: "Unremitted", value: formatPesoAscii(data.totals.unremitted ?? 0) },
      { label: "Uncollected", value: formatPesoAscii(data.totals.uncollected ?? 0) },
    ],
    tables: [
      periodTable<Point>("Transactions", unit, points, [
        { header: "Transactions", width: 100, align: "right", value: (r) => String(r.count), total: String(sum(points, (r) => r.count)) },
        { header: "Amount", width: 120, align: "right", value: (r) => formatPesoAscii(r.amount), total: formatPesoAscii(sum(points, (r) => r.amount)) },
        { header: "Service fees", width: 120, align: "right", value: (r) => formatPesoAscii(r.deliveryFee), total: formatPesoAscii(sum(points, (r) => r.deliveryFee)) },
      ]),
      table<MethodRow>({
        title: "By payment method",
        columns: [
          { header: "Payment method", width: 360, value: (r) => r.paymentMethod },
          { header: "Transactions", width: 180, align: "right", value: (r) => String(r.count) },
          { header: "Amount", width: 180, align: "right", value: (r) => formatPesoAscii(r.amount) },
        ],
        rows: data.byPaymentMethod,
        totals: ["Total", String(data.totals.count), formatPesoAscii(data.totals.amount)],
      }),
      table<(typeof data.byErrandStatus)[number]>({
        title: "By order status",
        columns: [
          { header: "Status", width: 360, value: (r) => plainStatus(r.status) },
          { header: "Transactions", width: 180, align: "right", value: (r) => String(r.count) },
          { header: "Amount", width: 180, align: "right", value: (r) => formatPesoAscii(r.amount) },
        ],
        rows: data.byErrandStatus,
      }),
      table<Row>({
        title: "Every transaction in these dates",
        columns: [
          { header: "Order", width: 120, value: (r) => r.referenceNo ?? referenceKey(r.errandId) },
          { header: "Store type", width: 110, value: (r) => r.category },
          { header: "Rider", width: 90, value: (r) => r.riderName ?? "Not assigned" },
          { header: "Customer", width: 90, value: (r) => r.customerName ?? "-" },
          { header: "Amount", width: 85, align: "right", value: (r) => formatPesoAscii(r.amount) },
          {
            header: "Service fee",
            width: 80,
            align: "right",
            value: (r) => formatPesoAscii(r.deliveryFee),
          },
          { header: "Payment", width: 85, value: (r) => r.paymentMethod },
          // Full status, not an abbreviation: Delivered, Completed and
          // Cancelled are indistinguishable at three characters.
          { header: "Status", width: 60, value: (r) => plainStatus(r.errandStatus) },
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
    // Owner, 2026-10-27: "Service fee" not "Delivery fee", no "About these numbers".
    notes: [] as string[],
  };
}

// ── help desk (exceptions) ─────────────────────────────────────────────────

/** Shared with the Owner portal's Help Desk Report, which uses the same words. */
export const KIND_LABEL: Record<string, string> = {
  CASH_VARIANCE: "Cash short or over",
  // The Help Desk Report counts cash short and cash over apart (owner, 2026-10-27).
  CASH_SHORT: "Cash short",
  CASH_OVER: "Cash over",
  RECEIPT_DIVERGENCE: "Receipt amount does not match",
  UNVERIFIED_PURCHASE: "Purchase with no receipt",
  WRONG_BRANCH: "Bought at a different store",
  MISSING_RECEIPT: "No receipt for a stop",
  STALLED_STOP: "Rider stayed too long at a store",
  OVERAGE_PENDING: "Items held: extra cost not approved yet",
  UNPAID_BALANCE: "Balance not paid",
  CANCELLED_AFTER_PURCHASE: "Cancelled after items were bought",
};

async function exceptionsSpec(request: ReportRequest, unit: BucketUnit) {
  const data = await reportService.getExceptionReport(request);
  type KindRow = (typeof data.summary.byKind)[number];
  type RiderRow = (typeof data.riders)[number];
  type ExceptionRow = (typeof data.exceptions)[number];
  type Point = (typeof data.timelineBreakdown)[number];
  const points = data.timelineBreakdown;
  const money = (v: number) => (v > 0 ? formatPesoAscii(v) : "-");

  return {
    rangeLabel: data.meta.rangeLabel,
    summary: [
      { label: "Still open", value: String(data.summary.openCount) },
      { label: "Cleared", value: String(data.summary.resolvedCount) },
      { label: "Money involved", value: formatPesoAscii(data.summary.totalAtRisk) },
    ],
    tables: [
      periodTable<Point>("Problems", unit, points, [
        { header: "Problems", width: 85, align: "right", value: (r) => String(r.count), total: String(sum(points, (r) => r.count)) },
        { header: "Still open", width: 85, align: "right", value: (r) => String(r.openCount), total: String(sum(points, (r) => r.openCount)) },
        { header: "Cleared", width: 85, align: "right", value: (r) => String(r.resolvedCount), total: String(sum(points, (r) => r.resolvedCount)) },
        { header: "Money involved", width: 110, align: "right", value: (r) => money(r.atRisk), total: formatPesoAscii(sum(points, (r) => r.atRisk)) },
      ]),
      table<KindRow>({
        title: "Problems by type",
        columns: [
          { header: "Problem", width: 360, value: (r) => KIND_LABEL[r.kind] ?? r.kind },
          { header: "Count", width: 180, align: "right", value: (r) => String(r.count) },
          { header: "Money involved", width: 180, align: "right", value: (r) => money(r.atRisk) },
        ],
        rows: data.summary.byKind,
      }),
      table<RiderRow>({
        title: "Problems by rider",
        columns: [
          { header: "Rider", width: 230, value: (r) => r.riderName ?? `Rider ${r.riderId}` },
          { header: "Errands", width: 110, align: "right", value: (r) => String(r.errandCount) },
          { header: "Problems", width: 120, align: "right", value: (r) => String(r.exceptionCount) },
          // A whole number, not 0.43 (owner, 2026-10-27): problems per 100 errands.
          { header: "Per 100 errands", width: 120, align: "right", value: (r) => String(Math.round(r.rate * 100)) },
          { header: "Money involved", width: 140, align: "right", value: (r) => money(r.atRisk) },
        ],
        rows: data.riders,
      }),
      table<ExceptionRow>({
        title: "Every problem in these dates",
        columns: [
          { header: "Errand", width: 115, value: (r) => r.referenceNo ?? referenceKey(r.errandId) },
          { header: "Problem", width: 120, value: (r) => KIND_LABEL[r.problem] ?? KIND_LABEL[r.kind] ?? r.kind },
          { header: "Money involved", width: 80, align: "right", value: (r) => money(r.amountAtRisk) },
          { header: "Rider", width: 90, value: (r) => r.riderName ?? "-" },
          { header: "What happened", width: 175, value: (r) => r.detail },
          {
            header: "Status",
            width: 140,
            // Who cleared it, not their note (owner, 2026-10-27). The note stays
            // on screen and in the CSV.
            value: (r) => (r.resolvedAt ? `Cleared by ${r.resolvedBy ?? "-"}` : "Open"),
          },
        ],
        rows: data.exceptions,
      }),
    ],
    notes: [
      `Differences under ${formatPesoAscii(data.materialityPesos)} are not counted as problems.`,
      "Each problem is counted on the day its errand was placed.",
      "Cleared problems stay on this list on purpose: who cleared each one, and why, " +
        "matters if there is a dispute later.",
    ],
  };
}
