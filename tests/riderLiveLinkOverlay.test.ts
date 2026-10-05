import { beforeEach, describe, expect, it, vi } from "vitest";

const { live, row } = vi.hoisted(() => ({
  live: { value: null as null | { lastHeartbeatAt: number; lost: boolean } },
  row: { value: null as any },
}));

vi.mock("../src/repositories/riderPresenceRepository.js", () => ({
  riderPresenceRepository: { findMany: vi.fn(async () => (row.value ? [row.value] : [])) },
}));
vi.mock("../src/repositories/riderLoginSessionRepository.js", () => ({
  riderLoginSessionRepository: { findAllOpen: vi.fn(async () => [{ riderId: 3 }]), open: vi.fn() },
}));
vi.mock("../src/lib/riderLocationBroadcast.js", () => ({ broadcastRiderLocation: vi.fn() }));
vi.mock("../src/lib/riderLiveLink.js", () => ({ liveLinkOf: vi.fn(() => live.value) }));

import { availabilityForRiders } from "../src/services/riderBeaconService.js";

const NOW = Date.UTC(2026, 8, 24, 3, 0, 0);

beforeEach(() => {
  row.value = {
    riderId: 3,
    onDuty: true,
    backgroundLocation: true,
    notifications: true,
    exactAlarms: true,
    beaconIntervalMs: 30_000,
    // An HTTP beacon eight seconds ago: by the beacon alone, comfortably online.
    lastBeaconAt: new Date(NOW - 8_000),
    shutdownAt: null,
  };
  live.value = null;
});

describe("the heartbeat over the beacon", () => {
  it("leaves a rider without a heartbeat to the beacon, as before", async () => {
    const a = (await availabilityForRiders([3], NOW)).get(3)!;
    expect(a.riderStatus).toBe("AVAILABLE_ONLINE");
  });

  it("drops a rider to Signal Lost the moment the heartbeat stops, beacon notwithstanding", async () => {
    live.value = { lastHeartbeatAt: NOW - 3_500, lost: true };
    const a = (await availabilityForRiders([3], NOW)).get(3)!;
    expect(a.riderStatus).toBe("AVAILABLE_SIGNAL_LOST");
    expect(a.dispatchable).toBe(false);
    expect(a.lastBeaconAt).toBe(NOW - 3_500);
  });

  it("keeps a rider online on a flowing heartbeat even when the HTTP beacon is late", async () => {
    row.value.lastBeaconAt = new Date(NOW - 5 * 60_000);
    live.value = { lastHeartbeatAt: NOW - 400, lost: false };
    const a = (await availabilityForRiders([3], NOW)).get(3)!;
    expect(a.riderStatus).toBe("AVAILABLE_ONLINE");
  });

  it("never makes an off-duty rider look online", async () => {
    row.value.onDuty = false;
    live.value = { lastHeartbeatAt: NOW - 400, lost: false };
    const a = (await availabilityForRiders([3], NOW)).get(3)!;
    expect(a.riderStatus).toBe("OFFLINE");
  });
});
