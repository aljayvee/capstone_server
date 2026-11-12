import { describe, expect, it } from "vitest";
import { resolveRange } from "../src/services/patterns/dateRangeResolver.js";
import {
  breakdown,
  describeCoverage,
  formatDates,
  periodBuckets,
} from "../src/services/patterns/periodBuckets.js";

// Thursday 22 October 2026, local time: the day the Daily print bug was reported.
const THURSDAY = new Date(2026, 9, 22, 15, 15);

const plan = (period: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY", date = THURSDAY) => {
  const r = resolveRange({ period, date });
  return periodBuckets(r.period, r.start, r.end);
};

describe("periodBuckets", () => {
  it("splits a Daily window into Sunday to Saturday, with each day's date", () => {
    const { unit, buckets } = plan("DAILY");

    expect(unit).toBe("day");
    expect(buckets.map((b) => b.label)).toEqual([
      "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    ]);
    expect(buckets.map((b) => b.dateLabel)).toEqual([
      "Oct 18", "Oct 19", "Oct 20", "Oct 21", "Oct 22", "Oct 23", "Oct 24",
    ]);
  });

  it("starts the week on Sunday even when the reference day is a Sunday", () => {
    const { buckets } = plan("DAILY", new Date(2026, 9, 18, 9));
    expect(buckets[0].dateLabel).toBe("Oct 18");
    expect(buckets[6].dateLabel).toBe("Oct 24");
  });

  it("keeps a month in four weeks and says how long the last one is", () => {
    const { unit, buckets } = plan("WEEKLY");

    expect(unit).toBe("week");
    expect(buckets.map((b) => b.label)).toEqual(["Week 1", "Week 2", "Week 3", "Week 4"]);
    expect(buckets.map((b) => b.dateLabel)).toEqual([
      "Oct 1 to 7", "Oct 8 to 14", "Oct 15 to 21", "Oct 22 to 31",
    ]);
  });

  it("names every month of the year", () => {
    const { unit, buckets } = plan("MONTHLY");

    expect(unit).toBe("month");
    expect(buckets).toHaveLength(12);
    expect(buckets[0].label).toBe("January");
    expect(buckets[11].label).toBe("December");
    expect(buckets[1].dateLabel).toBe("Feb 1 to 28");
  });

  it("covers the five years a Yearly window spans", () => {
    const { unit, buckets } = plan("YEARLY");

    expect(unit).toBe("year");
    expect(buckets.map((b) => b.label)).toEqual(["2022", "2023", "2024", "2025", "2026"]);
  });

  it("picks a granularity for a drawn range so it never prints without a breakdown", () => {
    const custom = (start: Date, end: Date) => {
      const r = resolveRange({ start, end });
      return periodBuckets(r.period, r.start, r.end);
    };

    const fiveDays = custom(new Date(2026, 9, 19), new Date(2026, 9, 23));
    expect(fiveDays.unit).toBe("day");
    expect(fiveDays.buckets.map((b) => b.label)).toEqual([
      "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
    ]);

    const month = custom(new Date(2026, 8, 1), new Date(2026, 8, 30));
    expect(month.unit).toBe("week");
    expect(month.buckets.at(-1)?.dateLabel).toBe("Sep 29 to 30");

    const quarter = custom(new Date(2026, 6, 15), new Date(2026, 9, 10));
    expect(quarter.unit).toBe("month");
    expect(quarter.buckets.map((b) => b.label)).toEqual(["July", "August", "September", "October"]);
    expect(quarter.buckets[0].dateLabel).toBe("Jul 15 to 31");

    const long = custom(new Date(2021, 0, 1), new Date(2026, 9, 22));
    expect(long.unit).toBe("year");
  });

  it("tiles the window exactly, with no gap and no overlap", () => {
    for (const period of ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const) {
      const r = resolveRange({ period, date: THURSDAY });
      const { buckets } = periodBuckets(r.period, r.start, r.end);

      expect(buckets[0].start.getTime()).toBe(r.start.getTime());
      expect(buckets.at(-1)?.end.getTime()).toBe(r.end.getTime());
      for (let i = 1; i < buckets.length; i++) {
        expect(buckets[i].start.getTime()).toBe(buckets[i - 1].end.getTime());
      }
    }
  });
});

describe("breakdown", () => {
  it("adds every row in the window to exactly one bucket", () => {
    const r = resolveRange({ period: "DAILY", date: THURSDAY });
    const rows = [
      { at: new Date(2026, 9, 18, 0, 0), amount: 10 }, // Sunday, first instant
      { at: new Date(2026, 9, 22, 23, 59), amount: 5 },
      { at: new Date(2026, 9, 24, 23, 59, 59), amount: 1 }, // Saturday, last second
    ];

    const out = breakdown(
      periodBuckets(r.period, r.start, r.end),
      rows,
      (row) => row.at,
      () => ({ count: 0, amount: 0 }),
      (f, row) => {
        f.count += 1;
        f.amount += row.amount;
      }
    );

    expect(out.map((p) => p.count)).toEqual([1, 0, 0, 0, 1, 0, 1]);
    expect(out.reduce((s, p) => s + p.amount, 0)).toBe(16);
  });
});

describe("describeCoverage", () => {
  it("names the days for Daily", () => {
    expect(describeCoverage(resolveRange({ period: "DAILY", date: THURSDAY }))).toBe(
      "This week, by day: Sunday, Oct 18, 2026 to Saturday, Oct 24, 2026"
    );
  });

  it("says what each other period covers", () => {
    expect(describeCoverage(resolveRange({ period: "WEEKLY", date: THURSDAY }))).toBe(
      "October 2026, by week"
    );
    expect(describeCoverage(resolveRange({ period: "MONTHLY", date: THURSDAY }))).toBe(
      "2026, by month"
    );
    expect(describeCoverage(resolveRange({ period: "YEARLY", date: THURSDAY }))).toBe(
      "2022 to 2026, by year"
    );
  });

  it("spells out a single custom day without a breakdown phrase", () => {
    const day = new Date(2026, 9, 22);
    expect(describeCoverage(resolveRange({ start: day, end: day }))).toBe("Thursday, Oct 22, 2026");
  });
});

describe("formatDates", () => {
  it("drops repeated month and year", () => {
    expect(formatDates(new Date(2026, 9, 8), new Date(2026, 9, 15))).toBe("Oct 8 to 14");
    expect(formatDates(new Date(2026, 8, 28), new Date(2026, 9, 5))).toBe("Sep 28 to Oct 4");
    expect(formatDates(new Date(2026, 11, 28), new Date(2027, 0, 4))).toBe(
      "Dec 28, 2026 to Jan 3, 2027"
    );
  });
});
