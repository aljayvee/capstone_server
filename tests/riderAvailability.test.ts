import { describe, expect, it } from "vitest";
import {
  availabilityOf,
  OFFLINE_AFTER_MS,
  signalLostAfterMs,
  DEFAULT_BEACON_INTERVAL_MS,
  type PresenceSnapshot,
} from "../src/lib/riderAvailability.js";

/**
 * The states a rider can be in, and which of them receives work.
 *
 * This replaces `riderPresenceStore.isOnline()` — a live Socket.IO connection and
 * nothing else — which failed in both directions: a rider whose socket Android's
 * battery optimiser had severed was excluded while sitting outside a store ready
 * to ride, and a rider whose socket was alive but whose location task had been
 * killed was included while being impossible to locate.
 */

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

const present = (over: Partial<PresenceSnapshot> = {}): PresenceSnapshot => ({
  hasSession: true,
  onDuty: true,
  backgroundLocation: true,
  notifications: true,
  exactAlarms: true,
  lastBeaconAt: NOW - 2000,
  shutdownAt: null,
  ...over,
});

describe("who can be given an errand", () => {
  it("dispatches to a rider in contact with every permission granted", () => {
    const r = availabilityOf(present(), NOW);
    expect(r.state).toBe("AVAILABLE");
    expect(r.dispatchable).toBe(true);
    expect(r.impediments).toEqual([]);
  });

  it("is the only state that dispatches", () => {
    const states = [
      present({ hasSession: false }),
      present({ onDuty: false }),
      present({ lastBeaconAt: NOW - signalLostAfterMs(null) - 1 }),
      present({ lastBeaconAt: NOW - OFFLINE_AFTER_MS - 1 }),
      present({ notifications: false }),
    ];
    for (const s of states) {
      expect(availabilityOf(s, NOW).dispatchable).toBe(false);
    }
  });
});

describe("the rider's own decisions come first", () => {
  it("reports no session as logged out, not as a connection problem", () => {
    // Reporting a signed-out rider as "signal lost" sends someone to chase a
    // network fault that does not exist.
    expect(availabilityOf(present({ hasSession: false, lastBeaconAt: null }), NOW).state).toBe(
      "LOGGED_OUT"
    );
  });

  it("reports the duty toggle as off duty even while beacons keep arriving", () => {
    expect(availabilityOf(present({ onDuty: false }), NOW).state).toBe("OFF_DUTY");
  });
});

describe("silence", () => {
  it("holds a rider available right up to the threshold", () => {
    expect(availabilityOf(present({ lastBeaconAt: NOW - signalLostAfterMs(null) }), NOW).state).toBe(
      "AVAILABLE"
    );
  });

  it("calls it signal lost one millisecond past it", () => {
    const r = availabilityOf(present({ lastBeaconAt: NOW - signalLostAfterMs(null) - 1 }), NOW);
    expect(r.state).toBe("SIGNAL_LOST");
    // Not offline: they keep the errands they are carrying.
    expect(r.presumed).toBe(false);
  });

  it("presumes offline past the grace window, and says it is a presumption", () => {
    const r = availabilityOf(present({ lastBeaconAt: NOW - OFFLINE_AFTER_MS - 1 }), NOW);
    expect(r.state).toBe("OFFLINE");
    expect(r.presumed).toBe(true);
  });

  it("treats a rider who has never beaconed as presumed offline", () => {
    const r = availabilityOf(present({ lastBeaconAt: null }), NOW);
    expect(r.state).toBe("OFFLINE");
    expect(r.presumed).toBe(true);
  });

  it("does NOT presume when the device reported its own shutdown", () => {
    // The one case where offline is observed rather than inferred, and the only
    // thing separating a powered-off handset from a dead zone.
    const r = availabilityOf(present({ shutdownAt: NOW - 1000 }), NOW);
    expect(r.state).toBe("OFFLINE");
    expect(r.presumed).toBe(false);
  });
});

describe("reachable but not equipped", () => {
  it("names a missing permission instead of blaming the network", () => {
    // Folding this into SIGNAL_LOST would put a permissions problem on the
    // dispatcher's screen wearing the label of a connectivity problem.
    const r = availabilityOf(present({ notifications: false }), NOW);
    expect(r.state).toBe("NEEDS_PERMISSIONS");
    expect(r.impediments).toEqual(["notifications"]);
  });

  it("reports every missing permission at once, so one fix trip clears them", () => {
    const r = availabilityOf(
      present({ backgroundLocation: false, notifications: false, exactAlarms: false }),
      NOW
    );
    expect(r.impediments).toEqual(["background_location", "notifications", "exact_alarms"]);
  });

  it("holds a rider back when only background location is missing", () => {
    // Granted-but-not-running counts as missing: the permission alone is not
    // evidence the OS let the task keep going.
    const r = availabilityOf(present({ backgroundLocation: false }), NOW);
    expect(r.dispatchable).toBe(false);
    expect(r.impediments).toEqual(["background_location"]);
  });

  it("ranks silence above permissions — out of contact is the bigger fact", () => {
    const r = availabilityOf(
      present({ notifications: false, lastBeaconAt: NOW - OFFLINE_AFTER_MS - 1 }),
      NOW
    );
    expect(r.state).toBe("OFFLINE");
  });
});

describe("the staleness window is sized to the beacon cadence", () => {
  /**
   * The bug: a flat 10s window against a 30s idle cadence. A rider beaconing
   * exactly on time was signal-lost for twenty seconds out of every thirty, so
   * auto-assign reported "no available riders" for a fleet that was working.
   */
  it("keeps an idle rider available across a full beacon gap", () => {
    const idle = 30 * 1000;
    // Just before their next beacon is even due.
    const snapshot = present({ lastBeaconAt: NOW - (idle - 1), beaconIntervalMs: idle });
    expect(availabilityOf(snapshot, NOW).state).toBe("AVAILABLE");
  });

  it("tolerates one dropped beacon, not an outage", () => {
    const idle = 30 * 1000;
    const oneMissed = present({ lastBeaconAt: NOW - idle * 1.5, beaconIntervalMs: idle });
    expect(availabilityOf(oneMissed, NOW).dispatchable).toBe(true);

    const outage = present({ lastBeaconAt: NOW - idle * 3, beaconIntervalMs: idle });
    expect(availabilityOf(outage, NOW).state).toBe("SIGNAL_LOST");
  });

  it("holds a rider on an errand to the tighter cadence they report", () => {
    const active = 10 * 1000;
    // 40s of silence is fine for an idle rider and far too long for an active one.
    const snapshot = present({ lastBeaconAt: NOW - 40 * 1000, beaconIntervalMs: active });
    expect(availabilityOf(snapshot, NOW).state).toBe("SIGNAL_LOST");
    expect(
      availabilityOf(present({ lastBeaconAt: NOW - 40 * 1000, beaconIntervalMs: 30000 }), NOW).state
    ).toBe("AVAILABLE");
  });

  it("falls back to the idle cadence when a device reports none", () => {
    // Assuming the SLOW cadence is the safe direction: assuming the fast one
    // would mark every older build permanently lost.
    expect(signalLostAfterMs(null)).toBe(DEFAULT_BEACON_INTERVAL_MS * 2.5);
    expect(signalLostAfterMs(undefined)).toBe(signalLostAfterMs(null));
    expect(signalLostAfterMs(0)).toBe(signalLostAfterMs(null));
  });
});
