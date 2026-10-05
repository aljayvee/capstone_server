import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, emitToRole, emit, createNotification, presenceUpdate, closeSession } = vi.hoisted(() => ({
  state: {
    riders: [{ id: 1, firstName: "Renen", lastName: "Cadungog" }],
    availability: new Map<number, any>(),
    onDutyRows: [] as Array<{ riderId: number }>,
    openSessions: [] as any[],
  },
  emitToRole: vi.fn(),
  emit: vi.fn(),
  createNotification: vi.fn(async () => ({})),
  presenceUpdate: vi.fn(async () => ({})),
  closeSession: vi.fn(async () => ({})),
}));

vi.mock("../src/lib/eventPublisher.js", () => ({ eventPublisher: { emitToRole, emit } }));
vi.mock("../src/lib/riderLocationBroadcast.js", () => ({ emitToRiderCustomers: vi.fn(async () => {}) }));
vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: { findAllRiders: vi.fn(async () => state.riders) },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { countActiveByRider: vi.fn(async () => []) },
}));
vi.mock("../src/repositories/notificationRepository.js", () => ({
  notificationRepository: { create: createNotification },
}));
vi.mock("../src/repositories/riderLoginSessionRepository.js", () => ({
  riderLoginSessionRepository: { findAllOpen: vi.fn(async () => state.openSessions), close: closeSession },
}));
vi.mock("../src/services/riderBeaconService.js", () => ({
  availabilityForRiders: vi.fn(async () => state.availability),
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => [{ id: 50 }, { id: 51 }]) },
    riderPresence: { findMany: vi.fn(async () => state.onDutyRows), updateMany: presenceUpdate },
  },
}));

import { checkRiderStatuses, resetShiftsAtMidnight, resetWatchState } from "../src/services/riderStatusWatchService.js";

const as = (riderStatus: string, riderStatusReason: string) => ({
  riderStatus,
  riderStatusReason,
  lastBeaconAt: 1,
});

const alerts = () => emitToRole.mock.calls.filter((c) => c[1] === "rider:connectivity_alert");
const changes = () => emitToRole.mock.calls.filter((c) => c[1] === "rider:status_changed");

const T0 = Date.UTC(2026, 8, 23, 7, 0, 0);

beforeEach(() => {
  resetWatchState();
  emitToRole.mockClear();
  emit.mockClear();
  createNotification.mockClear();
  presenceUpdate.mockClear();
  closeSession.mockClear();
  state.onDutyRows = [];
  state.openSessions = [];
});

describe("checkRiderStatuses", () => {
  it("raises nothing on the first pass after a restart", async () => {
    state.availability = new Map([[1, as("AVAILABLE_SIGNAL_LOST", "signal_lost")]]);
    await checkRiderStatuses(T0);
    expect(emitToRole).not.toHaveBeenCalled();
  });

  it("alerts dispatchers and fills their bells when an online rider loses signal", async () => {
    state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
    await checkRiderStatuses(T0);
    state.availability = new Map([[1, as("AVAILABLE_SIGNAL_LOST", "signal_lost")]]);
    await checkRiderStatuses(T0 + 20_000);
    await new Promise((r) => setImmediate(r));

    expect(changes().map((c) => c[0])).toEqual(["DISPATCHER", "OWNER"]);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0][2]).toMatchObject({ riderId: 1, name: "Renen Cadungog", reminder: false });
    expect(createNotification).toHaveBeenCalledTimes(2); // one per active dispatcher
  });

  it("reminds at 5 and 15 minutes, then stops", async () => {
    state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
    await checkRiderStatuses(T0);
    state.availability = new Map([[1, as("AVAILABLE_SIGNAL_LOST", "signal_lost")]]);
    await checkRiderStatuses(T0 + 1_000);
    for (const minutes of [2, 5, 10, 15, 30, 60]) {
      await checkRiderStatuses(T0 + 1_000 + minutes * 60_000);
    }
    const reminders = alerts().filter((c) => c[2].reminder);
    expect(reminders).toHaveLength(2);
  });

  it("does not alert for a rider who goes offline on purpose", async () => {
    state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
    await checkRiderStatuses(T0);
    state.availability = new Map([[1, as("OFFLINE", "off_duty")]]);
    await checkRiderStatuses(T0 + 20_000);
    expect(changes()).toHaveLength(2);
    expect(alerts()).toHaveLength(0);
  });

  it("does not fill the bell again for a rider whose signal flaps", async () => {
    for (let i = 0; i < 3; i++) {
      state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
      await checkRiderStatuses(T0 + i * 60_000);
      state.availability = new Map([[1, as("AVAILABLE_SIGNAL_LOST", "signal_lost")]]);
      await checkRiderStatuses(T0 + i * 60_000 + 20_000);
    }
    await new Promise((r) => setImmediate(r));
    expect(alerts()).toHaveLength(2 + 1); // live alert each time after the seed pass
    expect(createNotification).toHaveBeenCalledTimes(2); // once, for the two dispatchers
  });
});

describe("resetShiftsAtMidnight", () => {
  it("takes on-duty riders off duty, stamped at midnight, and closes open sessions at midnight", async () => {
    const midnight = Date.UTC(2026, 8, 22, 16, 0, 0); // 00:00 Manila
    state.onDutyRows = [{ riderId: 1 }, { riderId: 2 }];
    state.openSessions = [{ id: 9, riderId: 1, loginAt: new Date(midnight - 8 * 3600_000) }];

    const count = await resetShiftsAtMidnight(midnight + 30_000);

    expect(count).toBe(2);
    expect(presenceUpdate).toHaveBeenCalledWith({
      where: { riderId: { in: [1, 2] } },
      data: { onDuty: false, shutdownAt: new Date(midnight) },
    });
    expect(closeSession).toHaveBeenCalledWith(9, new Date(midnight), 8 * 3600);
    expect(emit).toHaveBeenCalledWith("rider:presence_changed", { riderId: 1, online: false });
  });
});
