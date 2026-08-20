import { errandRepository } from "../repositories/errandRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { getPeriodStrategy, type ReportPeriodStrategy } from "./patterns/reportPeriodStrategy.js";
import { splitRiderBusinessShare } from "./patterns/commissionSplit.js";

export type DashboardFrequency = "TODAY" | "WEEK" | "MONTH" | "YEAR";

export interface TrendPoint {
  label: string;
  revenue: number;
}

export interface DashboardSummary {
  riders: { total: number; active: number; inactive: number };
  errands: { pending: number; active: number; completedAllTime: number; cancelled: number };
  revenue: { gross: number; estimatedCommission: number; estimatedRiderPayouts: number; orderCount: number };
  trend: TrendPoint[];
}

// Facade: composes rider-roster, errand-status, and revenue queries from three
// different repositories into the one payload the Dashboard needs — the frontend
// never sees that composition, it just gets one object. See AGENTS.md's Facade
// Pattern guidance ("combining multiple ... operations behind one service call").
export async function getDashboardSummary(frequency: DashboardFrequency): Promise<DashboardSummary> {
  const now = new Date();
  const { start, end } = frequencyRange(frequency, now);

  const [riders, statusCounts, revenueRows] = await Promise.all([
    userRepository.findAllRiders(),
    errandRepository.countByStatus(),
    errandRepository.findRevenueRowsBetween(start, end),
  ]);

  return {
    riders: summarizeRiders(riders),
    errands: summarizeErrandStatus(statusCounts),
    revenue: summarizeRevenue(revenueRows),
    trend: buildTrend(revenueRows, start, end, frequency),
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

function summarizeRiders(riders: Array<{ status: string }>) {
  const total = riders.length;
  const active = riders.filter((r) => r.status === "Active").length;
  return { total, active, inactive: total - active };
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

// Commission/rider-payout split uses a fixed rate (see patterns/commissionSplit.ts)
// applied to historical order volume — the schema stores one bundled `deliveryFee`
// per errand, so this is presented as "estimated" rather than ledger-accurate.
function summarizeRevenue(rows: Array<{ totalCost: number }>) {
  const gross = rows.reduce((sum, r) => sum + r.totalCost, 0);
  const { riderShare, businessShare } = splitRiderBusinessShare(gross);
  return {
    gross: round2(gross),
    estimatedCommission: businessShare,
    estimatedRiderPayouts: riderShare,
    orderCount: rows.length,
  };
}

function buildTrend(
  rows: Array<{ createdAt: Date; totalCost: number }>,
  rangeStart: Date,
  rangeEnd: Date,
  frequency: DashboardFrequency
): TrendPoint[] {
  if (frequency === "TODAY") return bucketByHour(rows, rangeStart);

  const bucketStrategy = getPeriodStrategy(frequency === "WEEK" ? "DAILY" : frequency === "MONTH" ? "WEEKLY" : "MONTHLY");
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
