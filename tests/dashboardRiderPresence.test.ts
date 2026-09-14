import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: { findAllRiders: vi.fn() },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { countByStatus: vi.fn(), findRevenueRowsBetween: vi.fn() },
}));
vi.mock("../src/services/riderBeaconService.js", () => ({
  availabilityForRiders: vi.fn(),
}));

import { userRepository } from "../src/repositories/userRepository.js";
import { errandRepository } from "../src/repositories/errandRepository.js";
import * as riderBeaconService from "../src/services/riderBeaconService.js";
import { getDashboardSummary } from "../src/services/analyticsService.js";
import type { AvailabilityResult, RiderAvailability } from "../src/lib/riderAvailability.js";

function availability(state: RiderAvailability): AvailabilityResult {
  return {
    state,
    dispatchable: state === "AVAILABLE",
    impediments: [],
    beaconAgeMs: state === "AVAILABLE" ? 1000 : null,
    presumed: state === "OFFLINE",
  };
}

/** Three riders, all with ENABLED accounts, none of them actually working. */
const ROSTER = [
  { id: 1, status: "Active" },
  { id: 2, status: "Active" },
  { id: 3, status: "Active" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(userRepository.findAllRiders).mockResolvedValue(ROSTER as never);
  vi.mocked(errandRepository.countByStatus).mockResolvedValue([] as never);
  vi.mocked(errandRepository.findRevenueRowsBetween).mockResolvedValue([] as never);
});

describe("dashboard rider counts follow presence, not account status", () => {
  it("reports nobody on duty when every rider has gone silent", async () => {
    // THE BUG: this is the exact live state that produced the report — three
    // enabled accounts, last beacon days old. The tile said "3 Active Riders"
    // while the Live Map painted all three as signal-lost.
    vi.mocked(riderBeaconService.availabilityForRiders).mockResolvedValue(
      new Map([
        [1, availability("LOGGED_OUT")],
        [2, availability("LOGGED_OUT")],
        [3, availability("OFFLINE")],
      ])
    );

    const summary = await getDashboardSummary("TODAY");

    expect(summary.riders.active).toBe(0);
    expect(summary.riders.total).toBe(3);
    // The accounts are all still enabled — which is precisely why account
    // status was the wrong thing to count.
    expect(summary.riders.disabledAccounts).toBe(0);
  });

  it("counts a rider who is in contact and on duty", async () => {
    vi.mocked(riderBeaconService.availabilityForRiders).mockResolvedValue(
      new Map([
        [1, availability("AVAILABLE")],
        [2, availability("SIGNAL_LOST")],
        [3, availability("OFF_DUTY")],
      ])
    );

    const summary = await getDashboardSummary("TODAY");

    expect(summary.riders.active).toBe(1);
    expect(summary.riders.signalLost).toBe(1);
    expect(summary.riders.offDuty).toBe(1);
  });

  it("counts a rider missing a permission as on duty, not as offline", async () => {
    // They are reachable; they are missing a toggle. Filing them under offline
    // would send someone to debug a network problem that does not exist — the
    // distinction riderAvailability.ts exists to preserve.
    vi.mocked(riderBeaconService.availabilityForRiders).mockResolvedValue(
      new Map([
        [1, availability("NEEDS_PERMISSIONS")],
        [2, availability("OFFLINE")],
        [3, availability("OFFLINE")],
      ])
    );

    const summary = await getDashboardSummary("TODAY");

    expect(summary.riders.active).toBe(1);
    expect(summary.riders.offline).toBe(2);
  });

  it("does not count a disabled account as on duty just because it is disabled", async () => {
    // The inverse of the original bug: presence and account status are separate
    // facts, and neither may stand in for the other.
    vi.mocked(userRepository.findAllRiders).mockResolvedValue([
      { id: 1, status: "Inactive" },
      { id: 2, status: "Active" },
    ] as never);
    vi.mocked(riderBeaconService.availabilityForRiders).mockResolvedValue(
      new Map([
        [1, availability("AVAILABLE")],
        [2, availability("AVAILABLE")],
      ])
    );

    const summary = await getDashboardSummary("TODAY");

    expect(summary.riders.active).toBe(2);
    expect(summary.riders.disabledAccounts).toBe(1);
  });

  it("treats a rider with no availability entry as offline, never as active", async () => {
    // Failing open here would put a phantom rider on the dispatcher's screen.
    vi.mocked(riderBeaconService.availabilityForRiders).mockResolvedValue(new Map());

    const summary = await getDashboardSummary("TODAY");

    expect(summary.riders.active).toBe(0);
    expect(summary.riders.offline).toBe(3);
  });

  it("keeps active and inactive adding up to the roster", async () => {
    vi.mocked(riderBeaconService.availabilityForRiders).mockResolvedValue(
      new Map([
        [1, availability("AVAILABLE")],
        [2, availability("SIGNAL_LOST")],
        [3, availability("LOGGED_OUT")],
      ])
    );

    const summary = await getDashboardSummary("TODAY");

    expect(summary.riders.active + summary.riders.inactive).toBe(summary.riders.total);
  });
});
