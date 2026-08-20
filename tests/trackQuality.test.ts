import { describe, expect, it } from "vitest";
import { evaluateFix, type QualityCandidate } from "../src/lib/trackQuality.js";

const at = (seconds: number): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

const fix = (
  latitude: number,
  longitude: number,
  seconds: number,
  accuracyMeters: number | null = 10
): QualityCandidate => ({ latitude, longitude, accuracyMeters, recordedAt: at(seconds) });

describe("GPS quality gate", () => {
  it("accepts a first fix with no predecessor", () => {
    expect(evaluateFix(fix(6.6873, 124.6752, 0), null).accepted).toBe(true);
  });

  it("rejects a fix too imprecise to place a rider in a store", () => {
    const decision = evaluateFix(fix(6.6873, 124.6752, 0, 120), null);
    expect(decision).toEqual({ accepted: false, reason: "inaccurate" });
  });

  it("accepts a fix with unknown accuracy rather than discarding it", () => {
    // Some Android devices report no accuracy at all; dropping those would blind
    // the trail on those handsets entirely.
    expect(evaluateFix(fix(6.6873, 124.6752, 0, null), null).accepted).toBe(true);
  });

  it("rejects an out-of-order fix", () => {
    const previous = fix(6.6873, 124.6752, 60);
    const decision = evaluateFix(fix(6.6874, 124.6753, 30), previous);
    expect(decision).toEqual({ accepted: false, reason: "out_of_order" });
  });

  it("rejects a duplicate timestamp as carrying no new information", () => {
    const previous = fix(6.6873, 124.6752, 60);
    expect(evaluateFix(fix(6.6874, 124.6753, 60), previous).reason).toBe("out_of_order");
  });

  it("rejects a teleport that implies an impossible speed", () => {
    // ~2.3 km in 1 second.
    const previous = fix(6.6873, 124.6752, 0);
    const decision = evaluateFix(fix(6.6702, 124.6635, 1), previous);
    expect(decision).toEqual({ accepted: false, reason: "implausible_speed" });
  });

  it("accepts ordinary riding speed", () => {
    // ~2.3 km over 5 minutes is about 28 km/h.
    const previous = fix(6.6873, 124.6752, 0);
    expect(evaluateFix(fix(6.6702, 124.6635, 300), previous).accepted).toBe(true);
  });
});
