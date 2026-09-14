import { describe, expect, it } from "vitest";
import {
  formatRangeLabel,
  parseLocalDate,
  resolveRange,
  spanInDays,
} from "../src/services/patterns/dateRangeResolver.js";
import { rangeRuleViolation } from "../src/validators/reportValidators.js";

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe("parseLocalDate", () => {
  it("builds local midnight, not UTC midnight", () => {
    // `new Date("2026-09-30")` is UTC midnight — a different calendar day in any
    // timezone behind UTC, and the wrong instant everywhere ahead of it. The
    // picker sends a calendar day, so it has to be built as one.
    const parsed = parseLocalDate("2026-09-30")!;

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(8);
    expect(parsed.getDate()).toBe(30);
    expect(parsed.getHours()).toBe(0);
  });

  it("rejects a day that does not exist rather than rolling it forward", () => {
    // new Date(2026, 1, 31) silently becomes 3 March. A report window that
    // quietly moved to a different month would be very hard to notice.
    expect(parseLocalDate("2026-02-31")).toBeNull();
  });

  it("rejects anything that is not a plain calendar day", () => {
    expect(parseLocalDate("2026-09-30T10:00:00Z")).toBeNull();
    expect(parseLocalDate("30/09/2026")).toBeNull();
    expect(parseLocalDate("")).toBeNull();
  });
});

describe("resolveRange — explicit range", () => {
  it("includes the whole of the day the user picked as the end", () => {
    // THE off-by-one that matters. Repositories filter `{ gte: start, lt: end }`,
    // so an unadjusted end bound drops everything that happened on the final
    // day — the last day of the month missing from a monthly report, with
    // nothing on the page to suggest anything was left out.
    const resolved = resolveRange({ start: day(2026, 9, 1), end: day(2026, 9, 30) });

    expect(resolved.end).toEqual(day(2026, 10, 1));

    const lastMoment = new Date(2026, 8, 30, 23, 59, 59);
    expect(lastMoment >= resolved.start && lastMoment < resolved.end).toBe(true);
  });

  it("covers exactly one day when start and end are the same", () => {
    const resolved = resolveRange({ start: day(2026, 9, 15), end: day(2026, 9, 15) });

    expect(spanInDays(resolved)).toBe(1);
    expect(resolved.end).toEqual(day(2026, 9, 16));
  });

  it("normalises a start that carries a time component", () => {
    const resolved = resolveRange({
      start: new Date(2026, 8, 1, 14, 30),
      end: day(2026, 9, 2),
    });

    expect(resolved.start).toEqual(day(2026, 9, 1));
  });

  it("takes precedence over a named period supplied alongside it", () => {
    // The picker sends the range next to whatever preset was last selected. The
    // explicit instruction is the specific one and has to win, or the page would
    // show a window the user did not draw.
    const resolved = resolveRange({
      period: "YEARLY",
      date: day(2020, 1, 1),
      start: day(2026, 9, 1),
      end: day(2026, 9, 30),
    });

    expect(resolved.period).toBe("CUSTOM");
    expect(resolved.start).toEqual(day(2026, 9, 1));
  });

  it("falls back to the named period when only one end is supplied", () => {
    // Half a range is not an instruction. The validator rejects this at the
    // edge; the resolver must not invent a window from it either.
    const resolved = resolveRange({ period: "MONTHLY", date: day(2026, 9, 15), start: day(2026, 9, 1) });

    expect(resolved.period).toBe("MONTHLY");
    expect(resolved.start).toEqual(day(2026, 9, 1));
    expect(resolved.end).toEqual(day(2026, 10, 1));
  });
});

describe("resolveRange — named periods still work", () => {
  it("resolves a month from a reference date", () => {
    const resolved = resolveRange({ period: "MONTHLY", date: day(2026, 8, 15) });

    expect(resolved.start).toEqual(day(2026, 8, 1));
    expect(resolved.end).toEqual(day(2026, 9, 1));
    expect(resolved.label).toBe("August 2026");
    expect(resolved.period).toBe("MONTHLY");
  });

  it("defaults to today when nothing is supplied at all", () => {
    const resolved = resolveRange({});
    const now = new Date();

    expect(resolved.period).toBe("DAILY");
    expect(resolved.start.getDate()).toBe(now.getDate());
  });
});

describe("formatRangeLabel", () => {
  it("names a single day once", () => {
    expect(formatRangeLabel(day(2026, 9, 30), day(2026, 9, 30))).toBe("Sep 30, 2026");
  });

  it("drops the repeated year within one year", () => {
    expect(formatRangeLabel(day(2026, 9, 1), day(2026, 9, 30))).toBe("Sep 1 – Sep 30, 2026");
  });

  it("keeps both years when the range crosses one", () => {
    expect(formatRangeLabel(day(2025, 12, 28), day(2026, 1, 3))).toBe("Dec 28, 2025 – Jan 3, 2026");
  });

  it("names the day the user picked, not the exclusive bound", () => {
    // The label and the query must agree about the last day covered.
    const resolved = resolveRange({ start: day(2026, 9, 1), end: day(2026, 9, 30) });
    expect(resolved.label).toBe("Sep 1 – Sep 30, 2026");
  });
});

describe("rangeRuleViolation", () => {
  it("requires start and end to travel together", () => {
    expect(rangeRuleViolation({ start: day(2026, 9, 1) })).toMatch(/together/);
    expect(rangeRuleViolation({ end: day(2026, 9, 1) })).toMatch(/together/);
    expect(rangeRuleViolation({})).toBeNull();
  });

  it("rejects a backwards range", () => {
    expect(rangeRuleViolation({ start: day(2026, 9, 30), end: day(2026, 9, 1) })).toMatch(/before/);
  });

  it("accepts a single-day range", () => {
    expect(rangeRuleViolation({ start: day(2026, 9, 1), end: day(2026, 9, 1) })).toBeNull();
  });

  it("caps the span, because the reports load every errand in the window", () => {
    expect(rangeRuleViolation({ start: day(2020, 1, 1), end: day(2026, 1, 1) })).toMatch(/at most/);
    expect(rangeRuleViolation({ start: day(2026, 1, 1), end: day(2026, 12, 31) })).toBeNull();
  });
});
