import { describe, expect, it } from "vitest";
import {
  availabilityOf,
  isMidnightReset,
  mostRecentManilaMidnight,
  OFFLINE_AFTER_MS,
  signalLostAfterMs,
  type PresenceSnapshot,
} from "../src/lib/riderAvailability.js";

// 2026-09-23 15:00 Manila = 07:00 UTC.
const NOW = Date.UTC(2026, 8, 23, 7, 0, 0);
// 2026-09-23 00:00 Manila = 2026-09-22 16:00 UTC.
const MIDNIGHT = Date.UTC(2026, 8, 22, 16, 0, 0);

const present = (overrides: Partial<PresenceSnapshot> = {}): PresenceSnapshot => ({
  hasSession: true,
  onDuty: true,
  backgroundLocation: true,
  notifications: true,
  exactAlarms: true,
  lastBeaconAt: NOW - 5_000,
  beaconIntervalMs: 30_000,
  shutdownAt: null,
  ...overrides,
});

const statusOf = (s: PresenceSnapshot) => {
  const r = availabilityOf(s, NOW);
  return [r.riderStatus, r.riderStatusReason];
};

describe("the three rider statuses", () => {
  it("Available Online: on duty, reachable, background location allowed", () => {
    expect(statusOf(present())).toEqual(["AVAILABLE_ONLINE", "online"]);
  });

  it("Available Signal Lost: on duty but beacons stopped", () => {
    expect(statusOf(present({ lastBeaconAt: NOW - signalLostAfterMs(30_000) - 1 }))).toEqual([
      "AVAILABLE_SIGNAL_LOST",
      "signal_lost",
    ]);
  });

  it("stays Signal Lost after a long silence: a rider who never signed off has not gone offline", () => {
    expect(statusOf(present({ lastBeaconAt: NOW - OFFLINE_AFTER_MS * 20 }))).toEqual([
      "AVAILABLE_SIGNAL_LOST",
      "no_signal",
    ]);
  });

  it("stays Signal Lost when the abandoned-session sweep closed the session", () => {
    expect(
      statusOf(present({ hasSession: false, lastBeaconAt: NOW - OFFLINE_AFTER_MS * 3 }))
    ).toEqual(["AVAILABLE_SIGNAL_LOST", "no_signal"]);
  });

  it("Offline when the rider logged out (logout stamps the row off duty)", () => {
    expect(statusOf(present({ hasSession: false, onDuty: false, shutdownAt: NOW - 60_000 }))).toEqual([
      "OFFLINE",
      "logged_out",
    ]);
  });

  it("Offline when the rider went off duty", () => {
    expect(statusOf(present({ onDuty: false }))).toEqual(["OFFLINE", "off_duty"]);
  });

  it("Offline when the background service was stopped (shutdown beacon)", () => {
    expect(statusOf(present({ shutdownAt: NOW - 30_000 }))).toEqual(["OFFLINE", "service_stopped"]);
  });

  it("Offline, with the reason, when background location is not allowed", () => {
    expect(statusOf(present({ backgroundLocation: false }))).toEqual(["OFFLINE", "background_location"]);
    expect(statusOf(present({ notifications: false }))).toEqual(["OFFLINE", "notifications"]);
  });

  it("Offline when on duty but never heard from", () => {
    expect(statusOf(present({ lastBeaconAt: null }))).toEqual(["OFFLINE", "never_connected"]);
  });

  it("Offline with 'shift ended at 12:00 AM' after the midnight reset", () => {
    expect(
      statusOf(present({ hasSession: false, onDuty: false, shutdownAt: MIDNIGHT, lastBeaconAt: MIDNIGHT - 60_000 }))
    ).toEqual(["OFFLINE", "midnight_reset"]);
  });

  it("only Available Online is dispatchable", () => {
    expect(availabilityOf(present(), NOW).dispatchable).toBe(true);
    for (const s of [
      present({ lastBeaconAt: NOW - OFFLINE_AFTER_MS * 2 }),
      present({ backgroundLocation: false }),
      present({ onDuty: false }),
    ]) {
      expect(availabilityOf(s, NOW).dispatchable).toBe(false);
    }
  });
});

describe("Manila midnight", () => {
  it("finds the most recent 12:00 AM in Manila, not in UTC", () => {
    expect(mostRecentManilaMidnight(NOW)).toBe(MIDNIGHT);
    // 23:59 Manila still belongs to that day.
    expect(mostRecentManilaMidnight(MIDNIGHT + 24 * 3600_000 - 60_000)).toBe(MIDNIGHT);
    // One minute past the next midnight moves on.
    expect(mostRecentManilaMidnight(MIDNIGHT + 24 * 3600_000 + 60_000)).toBe(MIDNIGHT + 24 * 3600_000);
  });

  it("recognises the reset stamp, and nothing else, as the midnight reset", () => {
    expect(isMidnightReset(MIDNIGHT, NOW)).toBe(true);
    expect(isMidnightReset(MIDNIGHT + 5 * 60_000, NOW)).toBe(true);
    expect(isMidnightReset(MIDNIGHT + 3 * 3600_000, NOW)).toBe(false);
    // Yesterday's reset no longer explains today.
    expect(isMidnightReset(MIDNIGHT - 24 * 3600_000, NOW)).toBe(false);
    expect(isMidnightReset(null, NOW)).toBe(false);
  });
});
