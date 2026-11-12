import { errandRepository } from "../repositories/errandRepository.js";
import * as riderBeaconService from "./riderBeaconService.js";
import type { AvailabilityResult, RiderAvailability } from "../lib/riderAvailability.js";
import { userRepository } from "../repositories/userRepository.js";
import { getPeriodStrategy, type ReportPeriodStrategy, type ReportPeriod } from "./patterns/reportPeriodStrategy.js";
import { formatRangeLabel, spanInDays } from "./patterns/dateRangeResolver.js";
import { splitCommission } from "./patterns/commissionSplit.js";

export type DashboardFrequency = "TODAY" | "WEEK" | "MONTH" | "YEAR";

export interface TrendPoint {
  label: string;
  revenue: number;
}

export interface DashboardRange {
  /** Range start, local midnight. */
  start: Date;
  /** Range end as the user picked it — INCLUSIVE. */
  end: Date;
}

export interface DashboardSummary {
  /** What window these figures cover, so the page can say so. */
  rangeLabel: string;
  riders: {
    total: number;
    /** In contact and on duty right now. NOT the count of enabled accounts. */
    active: number;
    inactive: number;
    signalLost: number;
    offline: number;
    offDuty: number;
    disabledAccounts: number;
  };
  errands: { pending: number; active: number; completedAllTime: number; cancelled: number };
  revenue: { gross: number; estimatedCommission: number; estimatedRiderPayouts: number; orderCount: number };
  trend: TrendPoint[];
}

// Facade: composes rider-roster, errand-status, and revenue queries from three
// different repositories into the one payload the Dashboard needs — the frontend
// never sees that composition, it just gets one object. See AGENTS.md's Facade
// Pattern guidance ("combining multiple ... operations behind one service call").
export async function getDashboardSummary(
  frequency: DashboardFrequency,
  range?: DashboardRange,
  referenceDate?: Date
): Promise<DashboardSummary> {
  const now = referenceDate ?? new Date();

  // An explicit range supersedes the frequency preset — the same precedence the
  // reports use, so the two surfaces cannot disagree about which instruction is
  // the specific one. The end the user picked is inclusive; queries filter
  // `{ lt: end }`, so it is pushed to the following midnight — otherwise the
  // last day of every range would silently be missing from the totals.
  const { start, end, label } = range
    ? {
        start: new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate()),
        end: new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 1),
        label: formatRangeLabel(range.start, range.end),
      }
    : { ...frequencyRange(frequency, now), label: frequencyLabel(frequency, now) };

  const [riders, statusCounts, revenueRows] = await Promise.all([
    userRepository.findAllRiders(),
    errandRepository.countByStatus(),
    errandRepository.findRevenueRowsBetween(start, end),
  ]);

  // The same beacon-derived state the Riders board and dispatch read. Fetched
  // after the roster because it is keyed by rider id.
  const availability = await riderBeaconService.availabilityForRiders(riders.map((r) => r.id));

  return {
    rangeLabel: label,
    riders: summarizeRiders(riders, availability),
    errands: summarizeErrandStatus(statusCounts),
    revenue: summarizeRevenue(revenueRows),
    trend: buildTrend(
      revenueRows.map((r) => ({ createdAt: r.createdAt, sales: salesValue(r) })),
      start,
      end,
      range ? null : frequency
    ),
  };
}

function frequencyRange(frequency: DashboardFrequency, now: Date): { start: Date; end: Date } {
  const strategyByFrequency: Record<DashboardFrequency, ReportPeriodStrategy> = {
    TODAY: getPeriodStrategy("DAILY"),
    WEEK: getPeriodStrategy("WEEKLY"),
    MONTH: getPeriodStrategy("MONTHLY"),
    YEAR: getPeriodStrategy("YEARLY"),
  };
  return strategyByFrequency[frequency].range(now);
}

/** The preset's window, named the way the report headers name theirs. */
function frequencyLabel(frequency: DashboardFrequency, now: Date): string {
  const period: ReportPeriod =
    frequency === "TODAY" ? "DAILY" : frequency === "WEEK" ? "WEEKLY" : frequency === "MONTH" ? "MONTHLY" : "YEARLY";
  return getPeriodStrategy(period).label(now);
}

/**
 * How much of the fleet is actually working right now.
 *
 * `active` used to count `User.status === "Active"` — whether an ACCOUNT was
 * enabled, which has nothing to do with whether anyone is on shift. The tile
 * read "3 Active Riders" for a fleet whose last beacon was four days old, while
 * the Live Map showed the same three riders as signal-lost. Three surfaces, three
 * answers, one of them not about presence at all.
 *
 * Now derived from the same beacon state dispatch uses, so the Dashboard, the
 * Riders board and the map cannot disagree (AGENTS.md 8.10: the rider the
 * dispatcher sees as signal-lost MUST be the rider everyone else sees that way).
 *
 * NEEDS_PERMISSIONS counts as active on purpose: that rider is in contact and on
 * duty, just missing a toggle. Filing them under "offline" would send someone to
 * debug a network problem that does not exist — the distinction riderAvailability
 * exists to preserve.
 */
function summarizeRiders(
  riders: Array<{ id: number; status: string }>,
  availability: Map<number, AvailabilityResult>
) {
  const countWhere = (predicate: (state: RiderAvailability) => boolean) =>
    riders.filter((r) => predicate(availability.get(r.id)?.state ?? "OFFLINE")).length;

  const total = riders.length;
  const active = countWhere((s) => s === "AVAILABLE" || s === "NEEDS_PERMISSIONS");

  return {
    total,
    active,
    inactive: total - active,
    signalLost: countWhere((s) => s === "SIGNAL_LOST"),
    offline: countWhere((s) => s === "OFFLINE"),
    offDuty: countWhere((s) => s === "OFF_DUTY" || s === "LOGGED_OUT"),
    /** Accounts an owner has disabled. This is what `active` used to measure. */
    disabledAccounts: riders.filter((r) => r.status !== "Active").length,
  };
}

function summarizeErrandStatus(statusCounts: Array<{ status: string; _count: { _all: number } }>) {
  const countOf = (statuses: string[]) =>
    statusCounts.filter((s) => statuses.includes(s.status)).reduce((sum, s) => sum + s._count._all, 0);

  return {
    pending: countOf(["AVAILABLE", "PENDING"]),
    active: countOf(["ASSIGNED", "IN_TRANSIT"]),
    completedAllTime: countOf(["DELIVERED", "COMPLETED"]),
    cancelled: countOf(["CANCELLED"]),
  };
}

// `gross` is total order value, the items plus the delivery fee: the same figure
// as the Sales report's Total sales (reportService salesValue), tip left out.
// The split beside it is deliberately NOT taken on that figure:
// item cost is company money fronted for the purchase and carried by the rider,
// never earned by either party, so only the service fees are divided (see
// patterns/commissionSplit.ts).
//
// Still "estimated": it aggregates over errands rather than reading each recorded
// payout. reportService.getSettlementReport is the ledger-accurate view.
function summarizeRevenue(
  rows: Array<{ totalCost: number; deliveryFee: number; tip: number; estimatedCost: number }>
) {
  const gross = rows.reduce((sum, r) => sum + salesValue(r), 0);
  const { riderShare, businessShare } = splitCommission({
    deliveryFee: rows.reduce((sum, r) => sum + r.deliveryFee, 0),
    tip: rows.reduce((sum, r) => sum + r.tip, 0),
    itemCost: rows.reduce((sum, r) => sum + r.estimatedCost, 0),
  });
  return {
    gross: round2(gross),
    estimatedCommission: businessShare,
    estimatedRiderPayouts: riderShare,
    orderCount: rows.length,
  };
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_SHORT_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function buildTrend(
  rows: Array<{ createdAt: Date; sales: number }>,
  rangeStart: Date,
  rangeEnd: Date,
  frequency: DashboardFrequency | null
): TrendPoint[] {
  // 1. Daily: Sun, Mon, Tue, Wed, Thu, Fri, Sat
  if (frequency === "TODAY") {
    return bucketByDayOfWeek(rows, rangeStart);
  }

  // 2. Weekly: Week 1, Week 2, Week 3, Week 4
  if (frequency === "WEEK") {
    return bucketByFourWeeks(rows, rangeStart);
  }

  // 3. Monthly: Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec
  if (frequency === "MONTH") {
    return bucketByTwelveMonths(rows, rangeStart);
  }

  // 4. Yearly: Years (5 years)
  if (frequency === "YEAR") {
    return bucketByFiveYears(rows, rangeEnd);
  }

  // Custom date range picked via calendar picker:
  const days = spanInDays({ start: rangeStart, end: rangeEnd });
  if (days <= 7) {
    return bucketByDailyDates(rows, rangeStart, rangeEnd);
  }
  if (days <= 31) {
    return bucketByFourWeeks(rows, rangeStart);
  }
  if (days <= 365) {
    return bucketByTwelveMonths(rows, rangeStart);
  }
  return bucketByFiveYears(rows, rangeEnd);
}

function bucketByDayOfWeek(
  rows: Array<{ createdAt: Date; sales: number }>,
  weekStart: Date
): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
    const dayEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i + 1);
    const revenue = rows
      .filter((r) => r.createdAt >= dayStart && r.createdAt < dayEnd)
      .reduce((sum, r) => sum + r.sales, 0);
    points.push({ label: DAY_LABELS[i], revenue: round2(revenue) });
  }
  return points;
}

function bucketByFourWeeks(
  rows: Array<{ createdAt: Date; sales: number }>,
  monthStart: Date
): TrendPoint[] {
  const y = monthStart.getFullYear();
  const m = monthStart.getMonth();
  const nextMonth = new Date(y, m + 1, 1);
  const weekWindows = [
    { label: "Week 1", start: new Date(y, m, 1), end: new Date(y, m, 8) },
    { label: "Week 2", start: new Date(y, m, 8), end: new Date(y, m, 15) },
    { label: "Week 3", start: new Date(y, m, 15), end: new Date(y, m, 22) },
    { label: "Week 4", start: new Date(y, m, 22), end: nextMonth },
  ];

  return weekWindows.map((w) => {
    const revenue = rows
      .filter((r) => r.createdAt >= w.start && r.createdAt < w.end)
      .reduce((sum, r) => sum + r.sales, 0);
    return { label: w.label, revenue: round2(revenue) };
  });
}

function bucketByTwelveMonths(
  rows: Array<{ createdAt: Date; sales: number }>,
  yearStart: Date
): TrendPoint[] {
  const y = yearStart.getFullYear();
  const points: TrendPoint[] = [];
  for (let m = 0; m < 12; m++) {
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 1);
    const revenue = rows
      .filter((r) => r.createdAt >= start && r.createdAt < end)
      .reduce((sum, r) => sum + r.sales, 0);
    points.push({ label: MONTH_SHORT_NAMES[m], revenue: round2(revenue) });
  }
  return points;
}

function bucketByFiveYears(
  rows: Array<{ createdAt: Date; sales: number }>,
  rangeEnd: Date
): TrendPoint[] {
  const endYear = rangeEnd.getFullYear() - 1;
  const startYear = endYear - 4;
  const points: TrendPoint[] = [];
  for (let y = startYear; y <= endYear; y++) {
    const start = new Date(y, 0, 1);
    const end = new Date(y + 1, 0, 1);
    const revenue = rows
      .filter((r) => r.createdAt >= start && r.createdAt < end)
      .reduce((sum, r) => sum + r.sales, 0);
    points.push({ label: String(y), revenue: round2(revenue) });
  }
  return points;
}

function bucketByDailyDates(
  rows: Array<{ createdAt: Date; sales: number }>,
  rangeStart: Date,
  rangeEnd: Date
): TrendPoint[] {
  const points: TrendPoint[] = [];
  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
  while (cursor < rangeEnd) {
    const nextDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    const dayEnd = nextDay < rangeEnd ? nextDay : rangeEnd;
    const revenue = rows
      .filter((r) => r.createdAt >= cursor && r.createdAt < dayEnd)
      .reduce((sum, r) => sum + r.sales, 0);
    const dayLabel = cursor.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
    points.push({ label: dayLabel, revenue: round2(revenue) });
    cursor = nextDay;
  }
  return points;
}

/**
 * An errand's sales: `totalCost` (items + delivery fee + tip) without the tip.
 * The business takes no tips, but 100 delivered errands on prod carry tip 20
 * (PHP 2,000), which made this tile and the trend PHP 2,000 higher than the
 * Sales report. Kept identical to reportService's salesValue.
 */
function salesValue(r: { totalCost: number; tip: number }): number {
  return round2(r.totalCost - (r.tip ?? 0));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
