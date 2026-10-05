import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsert, findOpenForRider, openSession } = vi.hoisted(() => ({
  upsert: vi.fn(async () => ({})),
  findOpenForRider: vi.fn(async () => null),
  openSession: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("../src/repositories/riderPresenceRepository.js", () => ({ riderPresenceRepository: { upsert } }));
vi.mock("../src/repositories/riderLoginSessionRepository.js", () => ({
  riderLoginSessionRepository: { findOpenForRider, open: openSession },
}));
vi.mock("../src/lib/riderLocationBroadcast.js", () => ({ broadcastRiderLocation: vi.fn() }));
vi.mock("../src/lib/riderLiveLink.js", () => ({ liveLinkOf: vi.fn(() => null) }));

import { recordBeacon } from "../src/services/riderBeaconService.js";

// 03:00 Manila on 2026-09-23.
const NOW = Date.UTC(2026, 8, 22, 19, 0, 0);
const MIDNIGHT = Date.UTC(2026, 8, 22, 16, 0, 0);

const beacon = (dutySince: number | null) => ({
  latitude: 6.69,
  longitude: 124.67,
  onDuty: true,
  backgroundLocation: true,
  notifications: true,
  exactAlarms: true,
  beaconIntervalMs: 30_000,
  shuttingDown: false,
  dutySince,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  upsert.mockClear();
  openSession.mockClear();
});

describe("recordBeacon at the 12:00 AM shift boundary", () => {
  it("records a shift that began before midnight as offline, and tells the device to stop", async () => {
    const result = await recordBeacon(7, beacon(MIDNIGHT - 5 * 3600_000) as any);

    expect(result.forcedOffline).toBe("midnight_reset");
    expect(result.riderStatus).toBe("OFFLINE");
    expect(result.riderStatusReason).toBe("midnight_reset");
    expect(upsert.mock.calls[0][1]).toMatchObject({ onDuty: false, shutdownAt: new Date(MIDNIGHT) });
    expect(openSession).not.toHaveBeenCalled();
  });

  it("accepts a shift started after midnight as Available Online", async () => {
    const result = await recordBeacon(7, beacon(MIDNIGHT + 2 * 3600_000) as any);
    expect(result.forcedOffline).toBeNull();
    expect(result.riderStatus).toBe("AVAILABLE_ONLINE");
    expect(openSession).toHaveBeenCalled();
  });

  it("leaves a build without dutySince on the old behaviour", async () => {
    const result = await recordBeacon(7, beacon(null) as any);
    expect(result.forcedOffline).toBeNull();
    expect(result.riderStatus).toBe("AVAILABLE_ONLINE");
  });
});
