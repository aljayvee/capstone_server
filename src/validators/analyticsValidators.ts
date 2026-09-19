import { z } from "zod";
import { checkRange } from "./reportValidators.js";
import { parseLocalDate } from "../services/patterns/dateRangeResolver.js";

const calendarDay = z.string().transform((value, ctx) => {
  const parsed = parseLocalDate(value);
  if (!parsed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a date as YYYY-MM-DD" });
    return z.NEVER;
  }
  return parsed;
});

/**
 * The dashboard keeps its frequency presets AND accepts an explicit range.
 *
 * `start`/`end` win when both are present — same precedence the reports use, so
 * the two surfaces cannot disagree about which instruction is the specific one.
 * The range rules (paired, ordered, bounded) are shared with the report query
 * rather than restated, because a range the dashboard accepts and a report
 * rejects would be indefensible to a user looking at both.
 */
export const dashboardQuerySchema = z
  .object({
    frequency: z.enum(["TODAY", "WEEK", "MONTH", "YEAR"]).default("TODAY"),
    date: z.union([calendarDay, z.coerce.date()]).optional(),
    start: calendarDay.optional(),
    end: calendarDay.optional(),
  })
  .superRefine(checkRange);

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
