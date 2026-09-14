import { getPeriodStrategy, type ReportPeriod } from "./reportPeriodStrategy.js";

/**
 * Turns whatever a client asked for into the one [start, end) window every
 * report and the dashboard query against.
 *
 * Two ways to ask, and they have to agree about what a day is:
 *
 *  - **A named period plus a reference date** — the original contract, resolved
 *    by reportPeriodStrategy. Still how the period presets and the PDF export
 *    address a window.
 *  - **An explicit start and end** — what the calendar range picker sends.
 *
 * Shared rather than implemented per caller because a report and the dashboard
 * showing different totals for "September" is exactly the kind of discrepancy
 * nobody can debug from the outside.
 */

export interface ResolvedRange {
  start: Date;
  /** EXCLUSIVE. Every repository filters `{ gte: start, lt: end }`. */
  end: Date;
  label: string;
  /** What the caller asked for, echoed so the response can state its own basis. */
  period: ReportPeriod | "CUSTOM";
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Midnight, local time, on a `YYYY-MM-DD` day.
 *
 * `new Date("2026-09-30")` parses as UTC midnight, which is a different day in
 * any timezone behind UTC and the wrong instant in every timezone ahead of it.
 * The calendar sends a calendar day, so it has to be built as one.
 */
export function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(year, month - 1, day);

  // Rejects 2026-02-31, which would otherwise roll silently into March.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/**
 * "Sep 1 – Sep 30, 2026", or "Sep 30, 2026" for a single day.
 *
 * Takes the end the USER picked — inclusive — not the exclusive bound the
 * queries run on, so the label names a day that was actually included.
 */
export function formatRangeLabel(start: Date, endInclusive: Date): string {
  const sameDay =
    start.getFullYear() === endInclusive.getFullYear() &&
    start.getMonth() === endInclusive.getMonth() &&
    start.getDate() === endInclusive.getDate();

  if (sameDay) {
    return `${MONTHS[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`;
  }

  const sameYear = start.getFullYear() === endInclusive.getFullYear();
  const from = sameYear
    ? `${MONTHS[start.getMonth()]} ${start.getDate()}`
    : `${MONTHS[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`;
  const to = `${MONTHS[endInclusive.getMonth()]} ${endInclusive.getDate()}, ${endInclusive.getFullYear()}`;

  return `${from} – ${to}`;
}

export interface RangeRequest {
  period?: ReportPeriod;
  /** Reference date for the named period. Defaults to now. */
  date?: Date;
  /** Range start, local midnight. */
  start?: Date;
  /** Range end as the user picked it — INCLUSIVE. */
  end?: Date;
}

export function resolveRange(request: RangeRequest): ResolvedRange {
  const { start, end } = request;

  // An explicit range wins. It is the more specific instruction, and the picker
  // sends it alongside whatever period was last selected.
  if (start && end) {
    // The user picked a day, meaning through the END of that day. Queries filter
    // `lt: end`, so an unadjusted bound would silently drop the final day of
    // every range — the last day of the month missing from a monthly report,
    // with nothing on the page to suggest anything was left out.
    const exclusiveEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);

    return {
      start: startOfDay(start),
      end: exclusiveEnd,
      label: formatRangeLabel(start, end),
      period: "CUSTOM",
    };
  }

  const period = request.period ?? "DAILY";
  const reference = request.date ?? new Date();
  const strategy = getPeriodStrategy(period);
  const resolved = strategy.range(reference);

  return {
    start: resolved.start,
    end: resolved.end,
    label: strategy.label(reference),
    period,
  };
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole days a resolved range covers. Used to pick trend-chart granularity. */
export function spanInDays(range: { start: Date; end: Date }): number {
  return Math.max(1, Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000));
}
