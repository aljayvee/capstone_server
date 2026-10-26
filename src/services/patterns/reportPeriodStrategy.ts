export type ReportPeriod = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

// End is exclusive — callers filter with `{ gte: start, lt: end }`.
export interface DateRange {
  start: Date;
  end: Date;
}

// One Strategy per granularity: resolves an arbitrary reference date to the
// [start, end) window that granularity covers, plus a human label for report
// headers. Used by both reportService.ts (one total per resolved range) and
// analyticsService.ts (repeated calls build a bucketed trend series) — see
// AGENTS.md's Strategy Pattern guidance ("swappable algorithms... route
// optimization" is the general case; this is the report-period instance of it).
export interface ReportPeriodStrategy {
  range(reference: Date): DateRange;
  label(reference: Date): string;
  next(reference: Date): Date;
  previous(reference: Date): Date;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Sunday-based week, matching the Daily breakdown: Sun, Mon, Tue, Wed, Thu, Fri, Sat
function startOfWeekSunday(d: Date): Date {
  const day = startOfDay(d);
  const dow = day.getDay(); // 0=Sun..6=Sat
  day.setDate(day.getDate() - dow);
  return day;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

class DailyPeriodStrategy implements ReportPeriodStrategy {
  range(reference: Date): DateRange {
    const start = startOfWeekSunday(reference);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { start, end };
  }
  label(reference: Date): string {
    const { start, end } = this.range(reference);
    const last = new Date(end);
    last.setDate(last.getDate() - 1);
    const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${fmt(start)} - ${fmt(last)}, ${last.getFullYear()}`;
  }
  next(reference: Date): Date {
    const d = startOfWeekSunday(reference);
    d.setDate(d.getDate() + 7);
    return d;
  }
  previous(reference: Date): Date {
    const d = startOfWeekSunday(reference);
    d.setDate(d.getDate() - 7);
    return d;
  }
}

class WeeklyPeriodStrategy implements ReportPeriodStrategy {
  range(reference: Date): DateRange {
    const start = startOfMonth(reference);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return { start, end };
  }
  label(reference: Date): string {
    const start = startOfMonth(reference);
    return `${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()}`;
  }
  next(reference: Date): Date {
    const start = startOfMonth(reference);
    return new Date(start.getFullYear(), start.getMonth() + 1, 1);
  }
  previous(reference: Date): Date {
    const start = startOfMonth(reference);
    return new Date(start.getFullYear(), start.getMonth() - 1, 1);
  }
}

class MonthlyPeriodStrategy implements ReportPeriodStrategy {
  range(reference: Date): DateRange {
    const start = startOfYear(reference);
    const end = new Date(start.getFullYear() + 1, 0, 1);
    return { start, end };
  }
  label(reference: Date): string {
    return String(startOfYear(reference).getFullYear());
  }
  next(reference: Date): Date {
    return new Date(startOfYear(reference).getFullYear() + 1, 0, 1);
  }
  previous(reference: Date): Date {
    return new Date(startOfYear(reference).getFullYear() - 1, 0, 1);
  }
}

class YearlyPeriodStrategy implements ReportPeriodStrategy {
  range(reference: Date): DateRange {
    const endYear = reference.getFullYear();
    const start = new Date(endYear - 4, 0, 1);
    const end = new Date(endYear + 1, 0, 1);
    return { start, end };
  }
  label(reference: Date): string {
    const endYear = reference.getFullYear();
    return `${endYear - 4} - ${endYear}`;
  }
  next(reference: Date): Date {
    return new Date(reference.getFullYear() + 5, 0, 1);
  }
  previous(reference: Date): Date {
    return new Date(reference.getFullYear() - 5, 0, 1);
  }
}

const STRATEGIES: Record<ReportPeriod, ReportPeriodStrategy> = {
  DAILY: new DailyPeriodStrategy(),
  WEEKLY: new WeeklyPeriodStrategy(),
  MONTHLY: new MonthlyPeriodStrategy(),
  YEARLY: new YearlyPeriodStrategy(),
};

export function getPeriodStrategy(period: ReportPeriod): ReportPeriodStrategy {
  return STRATEGIES[period];
}
