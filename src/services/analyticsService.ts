import { errandRepository } from "../repositories/errandRepository.js";
import * as riderBeaconService from "./riderBeaconService.js";
import type { AvailabilityResult, RiderAvailability } from "../lib/riderAvailability.js";
import { userRepository } from "../repositories/userRepository.js";
import { getPeriodStrategy, type ReportPeriodStrategy } from "./patterns/reportPeriodStrategy.js";
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
    trend: buildTrend(revenueRows, start, end, range ? null : frequency),
  };
}

function frequencyRange(frequency: DashboardFrequency, now: Date): { start: Date; end: Date } {
  const strategyByFrequency: Record<Exclude<DashboardFrequency, "TODAY">, ReportPeriodStrategy> = {
    WEEK: getPeriodStrategy("WEEKLY"),
    MONTH: getPeriodStrategy("MONTHLY"),
    YEAR: getPeriodStrategy("YEARLY"),
  };
  if (frequency === "TODAY") return getPeriodStrategy("DAILY").range(now);
  return strategyByFrequency[frequency].range(now);
}

/** The preset's window, named the way the report headers name theirs. */
function frequencyLabel(frequency: DashboardFrequency, now: Date): string {
  const period = frequency === "TODAY" ? "DAILY" : frequency === "WEEK" ? "WEEKLY" : frequency === "MONTH" ? "MONTHLY" : "YEARLY";
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

// `gross` is total order value — what customers paid, including the money for the
// goods themselves. The split beside it is deliberately NOT taken on that figure:
// item cost is company money fronted for the purchase and carried by the rider,
// never earned by either party, so only the service fees are divided (see
// patterns/commissionSplit.ts).
//
// Still "estimated": it aggregates over errands rather than reading each recorded
// payout. reportService.getSettlementReport is the ledger-accurate view.
function summarizeRevenue(
  rows: Array<{ totalCost: number; deliveryFee: number; tip: number; estimatedCost: number }>
) {
  const gross = rows.reduce((sum, r) => sum + r.totalCost, 0);
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

/**
 * Bucket size for a range nobody named.
 *
 * A frequency preset carries its own answer (a week charts by day, a year by
 * month). An arbitrary range has to derive one from its length, or a 3-day
 * window would draw a single monthly bar and an 11-month window would draw 330
 * daily ones — both unreadable, in opposite directions.
 */
function bucketStrategyForSpan(days: number): ReportPeriodStrategy {
  if (days <= 31) return getPeriodStrategy("DAILY");
  if (days <= 180) return getPeriodStrategy("WEEKLY");
  return getPeriodStrategy("MONTHLY");
}

function buildTrend(
  rows: Array<{ createdAt: Date; totalCost: number }>,
  rangeStart: Date,
  rangeEnd: Date,
  frequency: DashboardFrequency | null
): TrendPoint[] {
  // A single-day custom range charts by hour for the same reason TODAY does:
  // one daily bar is not a trend.
  const days = spanInDays({ start: rangeStart, end: rangeEnd });
  if (frequency === "TODAY" || (frequency === null && days <= 1)) {
    return bucketByHour(rows, rangeStart);
  }

  const bucketStrategy =
    frequency === null
      ? bucketStrategyForSpan(days)
      : getPeriodStrategy(frequency === "WEEK" ? "DAILY" : frequency === "MONTH" ? "WEEKLY" : "MONTHLY");
  const points: TrendPoint[] = [];
  let cursor = rangeStart;
  while (cursor < rangeEnd) {
    const { start, end } = bucketStrategy.range(cursor);
    const bucketEnd = end < rangeEnd ? end : rangeEnd;
    const revenue = rows
      .filter((r) => r.createdAt >= start && r.createdAt < bucketEnd)
      .reduce((sum, r) => sum + r.totalCost, 0);
    points.push({ label: bucketStrategy.label(cursor), revenue: round2(revenue) });
    cursor = bucketStrategy.next(cursor);
  }
  return points;
}

function bucketByHour(rows: Array<{ createdAt: Date; totalCost: number }>, dayStart: Date): TrendPoint[] {
  const now = new Date();
  const isToday = dayStart.toDateString() === now.toDateString();
  const lastHour = isToday ? now.getHours() : 23;

  const points: TrendPoint[] = [];
  for (let hour = 0; hour <= lastHour; hour++) {
    const revenue = rows
      .filter((r) => r.createdAt.getHours() === hour)
      .reduce((sum, r) => sum + r.totalCost, 0);
    points.push({ label: formatHourLabel(hour), revenue: round2(revenue) });
  }
  return points;
}

function formatHourLabel(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour} ${period}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
