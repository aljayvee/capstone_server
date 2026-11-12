import type { ReportPeriod } from "./reportPeriodStrategy.js";
import type { ResolvedRange } from "./dateRangeResolver.js";

/**
 * The rows a report's period breakdown is split into.
 *
 * One definition for all six reports, on screen and in print. Before this, only
 * the Sales screen had a breakdown (its own inline loop), the PDF never printed
 * one, and a Daily printout named a date range instead of the days in it.
 *
 *  - DAILY   the week, Sunday to Saturday, one row per day
 *  - WEEKLY  the month in four weeks (Week 4 runs to the month's last day,
 *            the same four windows the screen has always shown)
 *  - MONTHLY the year, January to December
 *  - YEARLY  the five years the window covers
 *  - CUSTOM  by day up to a week, by week up to ~2 months, by month up to two
 *            years, then by year, so a drawn range never prints without one
 */

export type BucketUnit = "day" | "week" | "month" | "year";

export interface PeriodBucket {
  /** "Sunday", "Week 2", "January", "2026". */
  label: string;
  /** The dates the row covers, inclusive: "Oct 18", "Oct 8 to 14". */
  dateLabel: string;
  start: Date;
  /** EXCLUSIVE, like every other window in the reports. */
  end: Date;
}

export interface PeriodBreakdownPlan {
  unit: BucketUnit;
  buckets: PeriodBucket[];
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** "Oct 18", "Oct 8 to 14", "Sep 28 to Oct 4", "Dec 28, 2026 to Jan 3, 2027". */
export function formatDates(start: Date, endExclusive: Date): string {
  const last = addDays(endExclusive, -1);
  const day = (d: Date) => `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;

  if (sameDay(start, last)) return day(start);
  if (start.getFullYear() !== last.getFullYear()) {
    return `${day(start)}, ${start.getFullYear()} to ${day(last)}, ${last.getFullYear()}`;
  }
  if (start.getMonth() === last.getMonth()) return `${day(start)} to ${last.getDate()}`;
  return `${day(start)} to ${day(last)}`;
}

function bucket(label: string, start: Date, end: Date): PeriodBucket {
  return { label, dateLabel: formatDates(start, end), start, end };
}

function byDay(start: Date, end: Date): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  for (let d = start; d < end; d = addDays(d, 1)) {
    const next = addDays(d, 1);
    out.push(bucket(DAY_NAMES[d.getDay()], d, next < end ? next : end));
  }
  return out;
}

function byWeek(start: Date, end: Date): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  for (let d = start, n = 1; d < end; d = addDays(d, 7), n += 1) {
    const next = addDays(d, 7);
    out.push(bucket(`Week ${n}`, d, next < end ? next : end));
  }
  return out;
}

function byMonth(start: Date, end: Date): PeriodBucket[] {
  const spansYears = start.getFullYear() !== addDays(end, -1).getFullYear();
  const out: PeriodBucket[] = [];
  let cursor = start;
  while (cursor < end) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const name = MONTH_NAMES[cursor.getMonth()];
    out.push(bucket(spansYears ? `${name} ${cursor.getFullYear()}` : name, cursor, next < end ? next : end));
    cursor = next;
  }
  return out;
}

function byYear(start: Date, end: Date): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  let cursor = start;
  while (cursor < end) {
    const next = new Date(cursor.getFullYear() + 1, 0, 1);
    out.push(bucket(String(cursor.getFullYear()), cursor, next < end ? next : end));
    cursor = next;
  }
  return out;
}

export function periodBuckets(
  period: ReportPeriod | "CUSTOM",
  start: Date,
  end: Date
): PeriodBreakdownPlan {
  switch (period) {
    case "DAILY":
      return { unit: "day", buckets: byDay(start, end) };

    case "WEEKLY": {
      // Week 4 deliberately absorbs days 29 to 31: four rows is what the screen
      // and the dashboard have always shown for a month. Its date column says
      // how long it really is, so a ten-day "week" is never hidden.
      const y = start.getFullYear();
      const m = start.getMonth();
      const edges = [1, 8, 15, 22].map((day) => new Date(y, m, day));
      return {
        unit: "week",
        buckets: edges.map((s, i) => bucket(`Week ${i + 1}`, s, edges[i + 1] ?? end)),
      };
    }

    case "MONTHLY":
      return { unit: "month", buckets: byMonth(start, end) };

    case "YEARLY":
      return { unit: "year", buckets: byYear(start, end) };

    case "CUSTOM": {
      const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
      if (days <= 7) return { unit: "day", buckets: byDay(start, end) };
      if (days <= 62) return { unit: "week", buckets: byWeek(start, end) };
      if (days <= 731) return { unit: "month", buckets: byMonth(start, end) };
      return { unit: "year", buckets: byYear(start, end) };
    }
  }
}

/**
 * Folds rows into the buckets. A row whose date falls in no bucket is left out,
 * which cannot happen for a row the report's own window query returned: every
 * plan above tiles [start, end) exactly.
 */
export function breakdown<Row, Figures extends object>(
  plan: PeriodBreakdownPlan,
  rows: Row[],
  dateOf: (row: Row) => Date,
  empty: () => Figures,
  add: (figures: Figures, row: Row) => void
): Array<{ label: string; dateLabel: string } & Figures> {
  const filled = plan.buckets.map((b) => ({ head: b, figures: empty() }));

  for (const row of rows) {
    // A row with no usable date cannot be placed, and must not take the whole
    // report down with it.
    const at = dateOf(row)?.getTime?.();
    if (at === undefined || Number.isNaN(at)) continue;
    const slot = filled.find((f) => at >= f.head.start.getTime() && at < f.head.end.getTime());
    if (slot) add(slot.figures, row);
  }

  return filled.map(({ head, figures }) => ({ label: head.label, dateLabel: head.dateLabel, ...figures }));
}

const UNIT_PHRASE: Record<BucketUnit, string> = {
  day: "by day",
  week: "by week",
  month: "by month",
  year: "by year",
};

function longDay(d: Date): string {
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * The window as one plain sentence, for the line under a report's title and
 * the PDF header: "This week, by day: Sunday, Oct 18, 2026 to Saturday, Oct 24, 2026".
 */
export function describeCoverage(resolved: ResolvedRange): string {
  const { start, end, period } = resolved;
  const last = addDays(end, -1);
  const unit = periodBuckets(period, start, end).unit;

  switch (period) {
    case "DAILY":
      return `This week, ${UNIT_PHRASE[unit]}: ${longDay(start)} to ${longDay(last)}`;
    case "WEEKLY":
      return `${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()}, ${UNIT_PHRASE[unit]}`;
    case "MONTHLY":
      return `${start.getFullYear()}, ${UNIT_PHRASE[unit]}`;
    case "YEARLY":
      return `${start.getFullYear()} to ${last.getFullYear()}, ${UNIT_PHRASE[unit]}`;
    case "CUSTOM":
      return sameDay(start, last)
        ? longDay(start)
        : `${longDay(start)} to ${longDay(last)}, ${UNIT_PHRASE[unit]}`;
  }
}

/** What the Period line of a printout says, in words rather than the enum. */
export const PERIOD_NAMES: Record<ReportPeriod | "CUSTOM", string> = {
  DAILY: "Daily (Sunday to Saturday)",
  WEEKLY: "Weekly (Week 1 to Week 4)",
  MONTHLY: "Monthly (January to December)",
  YEARLY: "Yearly (last 5 years)",
  CUSTOM: "Custom dates",
};

/** "Sales per day", "Problems per month". */
export function breakdownTitle(subject: string, unit: BucketUnit): string {
  return `${subject} per ${unit}`;
}
