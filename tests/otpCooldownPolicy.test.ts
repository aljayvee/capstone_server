import { describe, expect, it } from "vitest";
import { cooldownSecondsFor, evaluateResend, streakSince } from "../src/services/otpCooldownPolicy.js";

describe("cooldownSecondsFor", () => {
  it("charges nothing before the first code goes out", () => {
    expect(cooldownSecondsFor(0)).toBe(0);
    expect(cooldownSecondsFor(-1)).toBe(0);
  });

  it("doubles with each code sent to the same recipient", () => {
    expect(cooldownSecondsFor(1)).toBe(60);
    expect(cooldownSecondsFor(2)).toBe(120);
    expect(cooldownSecondsFor(3)).toBe(240);
    expect(cooldownSecondsFor(4)).toBe(480);
  });

  it("stops doubling at the cap rather than running away", () => {
    expect(cooldownSecondsFor(5)).toBe(480);
    expect(cooldownSecondsFor(12)).toBe(480);
    // A count far past anything real must still be a sane number, not Infinity
    // or a value overflowed by the shift.
    expect(Number.isFinite(cooldownSecondsFor(500))).toBe(true);
    expect(cooldownSecondsFor(500)).toBe(480);
  });
});

describe("evaluateResend", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  const secondsAgo = (n: number) => new Date(now.getTime() - n * 1000);

  it("sends immediately when nothing has gone out, quoting the first wait", () => {
    expect(evaluateResend(null, 0, now)).toEqual({ allowed: true, retryAfterSeconds: 60 });
  });

  it("holds while the first minute is still running", () => {
    const result = evaluateResend(secondsAgo(20), 1, now);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(40);
  });

  it("releases once the wait has elapsed, quoting the doubled next wait", () => {
    expect(evaluateResend(secondsAgo(61), 1, now)).toEqual({
      allowed: true,
      retryAfterSeconds: 120,
    });
  });

  it("requires the doubled gap after a second code", () => {
    // 90s since the second code — past the first 60s step, short of 120s.
    expect(evaluateResend(secondsAgo(90), 2, now)).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });

    expect(evaluateResend(secondsAgo(121), 2, now)).toEqual({
      allowed: true,
      retryAfterSeconds: 240,
    });
  });

  it("never quotes a zero-second wait while still holding", () => {
    // Sub-second remainder must round up, or a client would show "0s" on a
    // button that is still refused.
    const result = evaluateResend(new Date(now.getTime() - 59_900), 1, now);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("never quotes a wait longer than the gap itself", () => {
    // A timestamp in the FUTURE — clock skew, or a row written in local time
    // against UTC-stored data. Unclamped this quoted hours and locked the
    // account's owner out until the clocks agreed.
    const eightHoursAhead = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const result = evaluateResend(eightHoursAhead, 1, now);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("caps a skewed future timestamp at the current step, not the ceiling", () => {
    const result = evaluateResend(new Date(now.getTime() + 60 * 60 * 1000), 3, now);

    expect(result.retryAfterSeconds).toBe(240);
  });

  it("treats a forgotten streak as a fresh start", () => {
    expect(evaluateResend(null, 4, now)).toEqual({ allowed: true, retryAfterSeconds: 60 });
  });
});

describe("streakSince", () => {
  it("looks back an hour by default", () => {
    const now = new Date("2026-08-21T12:00:00Z");

    expect(streakSince(now).toISOString()).toBe("2026-08-21T11:00:00.000Z");
  });
});
