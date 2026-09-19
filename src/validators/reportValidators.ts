import { z } from "zod";
import { parseLocalDate } from "../services/patterns/dateRangeResolver.js";

/**
 * A calendar day, as the picker sends it.
 *
 * Built at LOCAL midnight rather than through `z.coerce.date()`, which parses
 * "2026-09-30" as UTC midnight — a different calendar day anywhere behind UTC.
 * A range boundary that lands on the wrong day silently includes or drops a
 * day's takings.
 */
const calendarDay = z
  .string()
  .transform((value, ctx) => {
    const parsed = parseLocalDate(value);
    if (!parsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a date as YYYY-MM-DD" });
      return z.NEVER;
    }
    return parsed;
  });

/**
 * A year is the widest window worth serving in one request.
 *
 * The category-allocation reports load every errand in the range, so an
 * unbounded span is a way to ask the server to hold an unbounded number of rows
 * in memory. Rejecting is better than a request that takes a minute and then
 * fails somewhere less legible.
 */
const MAX_RANGE_DAYS = 366;

const rangeFields = {
  period: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).default("DAILY"),
  date: z.union([calendarDay, z.coerce.date()]).optional(),
  start: calendarDay.optional(),
  end: calendarDay.optional(),
};

/** The part of a query these rules apply to. */
export interface RangeShape {
  start?: Date;
  end?: Date;
}

/**
 * What is wrong with a requested range, or null if nothing is.
 *
 * A plain predicate rather than a generic schema wrapper: Zod v4's type surface
 * makes "any schema whose output has start and end" painful to express, and the
 * rules themselves are the part worth sharing. The reports and the dashboard
 * both apply it, because a range one accepts and the other rejects would be
 * indefensible to someone looking at both pages.
 *
 * The pairing rule matters most: `start` without `end` is an incomplete
 * instruction, and silently falling back to the named period would show a window
 * the user did not ask for while their half-made selection sat on screen.
 */
export function rangeRuleViolation(q: RangeShape): string | null {
  if ((q.start === undefined) !== (q.end === undefined)) {
    return "start and end must be provided together";
  }
  if (q.start && q.end) {
    if (q.end < q.start) return "end must not be before start";
    if ((q.end.getTime() - q.start.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      return `A date range may span at most ${MAX_RANGE_DAYS} days`;
    }
  }
  return null;
}

/** Attaches {@link rangeRuleViolation} to a schema that carries start/end. */
export function checkRange(q: RangeShape, ctx: z.RefinementCtx): void {
  const violation = rangeRuleViolation(q);
  if (violation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: violation });
}

export const reportQuerySchema = z.object(rangeFields).superRefine(checkRange);

export type ReportQuery = z.infer<typeof reportQuerySchema>;

// The PDF export is one route with the report type in the path, so the enum is
// what stops `/reports/anything/pdf` reaching the service layer.
export const REPORT_TYPES = [
  "sales",
  "rider-performance",
  "commission",
  "settlement",
  "transactions",
  "exceptions",
] as const;

export const reportPdfParamsSchema = z.object({
  reportType: z.enum(REPORT_TYPES, {
    message: `Report type must be one of: ${REPORT_TYPES.join(", ")}`,
  }),
});

export type ReportPdfParams = z.infer<typeof reportPdfParamsSchema>;

/** The dashboard asks the same way, plus its own frequency presets. */
export const analyticsRangeFields = rangeFields;
export { MAX_RANGE_DAYS };
