import { describe, expect, it } from "vitest";
import {
  evaluateFix,
  MAX_ANCHOR_AGE_SECONDS,
  type QualityCandidate,
} from "../src/lib/trackQuality.js";

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

  it("stops applying the speed check once the anchor is stale", () => {
    // The rider closed the app in one part of town and reopened it in another an
    // hour later. Across that gap "speed" measures how long the app was shut,
    // not whether the fix is plausible.
    const previous = fix(6.6873, 124.6752, 0);
    const later = fix(6.7200, 124.7100, MAX_ANCHOR_AGE_SECONDS + 1);
    expect(evaluateFix(later, previous).accepted).toBe(true);
  });

  it("still rejects a teleport inside the anchor window", () => {
    // The relaxation above must not become a way for a glitch to get in: within
    // the window the check applies exactly as before.
    // ~5.3 km in 60 s is ~88 m/s. Well inside the anchor window, and well past
    // anything a motorcycle does on a city street.
    const previous = fix(6.6873, 124.6752, 0);
    const teleport = fix(6.7200, 124.7100, 60);
    expect(evaluateFix(teleport, previous).reason).toBe("implausible_speed");
  });

  it("does not let one stale anchor reject an entire batch", () => {
    // The failure this guards against: ingestBatch only advances its anchor on
    // an ACCEPTED fix, so a first rejection leaves every later point in the
    // batch measured against the same stale point. Nothing is stored, the stale
    // point is still the latest one next time, and the trail never recovers.
    const stale = fix(6.6873, 124.6752, 0);
    const batch = [
      fix(6.7200, 124.7100, MAX_ANCHOR_AGE_SECONDS + 10),
      fix(6.7201, 124.7101, MAX_ANCHOR_AGE_SECONDS + 15),
      fix(6.7202, 124.7102, MAX_ANCHOR_AGE_SECONDS + 20),
    ];

    let previous: QualityCandidate | null = stale;
    const accepted: QualityCandidate[] = [];
    for (const point of batch) {
      if (evaluateFix(point, previous).accepted) {
        accepted.push(point);
        previous = point;
      }
    }

    expect(accepted).toHaveLength(batch.length);
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
