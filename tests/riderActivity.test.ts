import { describe, it, expect } from "vitest";
import { buildPeriods, manilaDay, todayInManila, type Sample } from "../src/services/riderActivityService.js";

const day = manilaDay("2026-11-15"); // 2026-11-14T16:00Z .. 2026-11-15T16:00Z
const at = (h: number, m: number) => new Date(day.start.getTime() + (h * 60 + m) * 60_000);
const every2 = (fromH: number, fromM: number, count: number, status: "ONLINE" | "OFFLINE"): Sample[] =>
  Array.from({ length: count }, (_, i) => ({ status, at: at(fromH, fromM + i * 2) }));
const shape = (ps: ReturnType<typeof buildPeriods>) => ps.map((p) => `${p.status} ${p.minutes}`);

describe("rider day periods", () => {
  it("reads a full day of samples as shifts", () => {
    const samples = [...every2(0, 0, 240, "OFFLINE"), ...every2(8, 0, 120, "ONLINE"), ...every2(12, 0, 360, "OFFLINE")];
    expect(shape(buildPeriods(samples, day.start, day.end, day.end))).toEqual(["OFFLINE 480", "ONLINE 240", "OFFLINE 720"]);
  });

  it("marks a stretch with no samples as no data, not as offline", () => {
    const samples = [...every2(8, 0, 30, "ONLINE"), ...every2(10, 0, 30, "ONLINE")];
    expect(shape(buildPeriods(samples, day.start, day.end, at(11, 0)))).toEqual(["NO_DATA 480", "ONLINE 60", "NO_DATA 60", "ONLINE 60"]);
  });

  it("stops at now for today instead of inventing the rest of the day", () => {
    const ps = buildPeriods(every2(0, 0, 10, "ONLINE"), day.start, day.end, at(0, 15));
    expect(shape(ps)).toEqual(["ONLINE 15"]);
  });

  it("gives an empty list for no samples", () => {
    expect(buildPeriods([], day.start, day.end, day.end)).toEqual([]);
  });
});

describe("Manila days", () => {
  it("maps a calendar date to its Manila midnight-to-midnight window", () => {
    expect(day.start.toISOString()).toBe("2026-11-14T16:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-11-15T16:00:00.000Z");
    expect(todayInManila(new Date("2026-11-15T17:00:00Z"))).toBe("2026-11-16");
  });

  it("refuses dates that are not YYYY-MM-DD", () => {
    expect(() => manilaDay("15/11/2026")).toThrow(/2026-11-15/);
  });
});
