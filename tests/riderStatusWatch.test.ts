import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, emitToRole, emit, createNotification, presenceUpdate, closeSession, findManyUsers, countActive } = vi.hoisted(() => ({
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
  findManyUsers: vi.fn(async (_args?: any) => [{ id: 50 }, { id: 51 }]),
  countActive: vi.fn(async () => [] as any[]),
}));

vi.mock("../src/lib/eventPublisher.js", () => ({ eventPublisher: { emitToRole, emit } }));
vi.mock("../src/lib/riderLocationBroadcast.js", () => ({ emitToRiderCustomers: vi.fn(async () => {}) }));
vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: { findAllRiders: vi.fn(async () => state.riders) },
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { countActiveByRider: countActive },
  dispatchLogRepository: { findLatestByErrandId: vi.fn(async () => null) },
}));
vi.mock("../src/repositories/notificationRepository.js", () => ({
  notificationRepository: { create: createNotification, findUnreadByRef: vi.fn(async () => null) },
}));
vi.mock("../src/repositories/riderLoginSessionRepository.js", () => ({
  riderLoginSessionRepository: { findAllOpen: vi.fn(async () => state.openSessions), close: closeSession },
}));
vi.mock("../src/services/riderBeaconService.js", () => ({
  availabilityForRiders: vi.fn(async () => state.availability),
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findMany: findManyUsers },
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
  findManyUsers.mockReset();
  findManyUsers.mockImplementation(async () => [{ id: 50 }, { id: 51 }]);
  countActive.mockReset();
  countActive.mockImplementation(async () => []);
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
    expect(alerts()).toHaveLength(0);
    expect(createNotification).not.toHaveBeenCalled();
    await checkRiderStatuses(T0 + 50_000);
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
    await checkRiderStatuses(T0 + 31_000);
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
      await checkRiderStatuses(T0 + i * 60_000 + 50_000);
    }
    await new Promise((r) => setImmediate(r));
    expect(alerts()).toHaveLength(1); // toasts share the bell's ten-minute cooldown
    // One loss row and one "back online" row, each for the two dispatchers.
    const types = createNotification.mock.calls.map((c: any[]) => c[0].type);
    expect(types).toEqual(["RIDER_SIGNAL_LOST", "RIDER_SIGNAL_LOST", "RIDER_SIGNAL_RESTORED", "RIDER_SIGNAL_RESTORED"]);
  });

  it("tells owners only when the lost rider has errands on hand", async () => {
    findManyUsers.mockImplementation(async ({ where }: any) => (where.role === "OWNER" ? [{ id: 90 }] : [{ id: 50 }]));
    countActive.mockResolvedValue([{ riderId: 1, _count: { _all: 2 } }]);
    state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
    await checkRiderStatuses(T0);
    state.availability = new Map([[1, as("AVAILABLE_SIGNAL_LOST", "signal_lost")]]);
    await checkRiderStatuses(T0 + 1_000);
    await checkRiderStatuses(T0 + 31_000);
    await new Promise((r) => setImmediate(r));

    const rows = createNotification.mock.calls.map((c: any[]) => c[0]);
    expect(rows.map((r) => r.userId).sort()).toEqual([50, 90]);
    expect(rows[0]).toMatchObject({ type: "RIDER_SIGNAL_LOST", priority: "HIGH", refKey: "rider:1" });
  });

  it("escalates to Critical once at the 15-minute reminder when errands are on hand", async () => {
    findManyUsers.mockImplementation(async ({ where }: any) => (where.role === "OWNER" ? [{ id: 90 }] : [{ id: 50 }]));
    countActive.mockResolvedValue([{ riderId: 1, _count: { _all: 1 } }]);
    state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
    await checkRiderStatuses(T0);
    state.availability = new Map([[1, as("AVAILABLE_SIGNAL_LOST", "signal_lost")]]);
    await checkRiderStatuses(T0 + 1_000);
    await checkRiderStatuses(T0 + 31_000);
    for (const minutes of [5, 15, 30]) {
      await checkRiderStatuses(T0 + 1_000 + minutes * 60_000);
    }
    await new Promise((r) => setImmediate(r));

    const critical = createNotification.mock.calls
      .map((c: any[]) => c[0])
      .filter((r) => r.type === "RIDER_SIGNAL_LOST_PERSISTING");
    expect(critical).toHaveLength(2); // the dispatcher and the owner, once
    expect(critical[0].priority).toBe("CRITICAL");
  });

  it("does not escalate a lost rider with nothing on hand", async () => {
    state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
    await checkRiderStatuses(T0);
    state.availability = new Map([[1, as("AVAILABLE_SIGNAL_LOST", "signal_lost")]]);
    await checkRiderStatuses(T0 + 1_000);
    await checkRiderStatuses(T0 + 31_000);
    for (const minutes of [5, 15, 30]) {
      await checkRiderStatuses(T0 + 1_000 + minutes * 60_000);
    }
    await new Promise((r) => setImmediate(r));
    const types = createNotification.mock.calls.map((c: any[]) => c[0].type);
    expect(types).not.toContain("RIDER_SIGNAL_LOST_PERSISTING");
  });

  it("keeps brief interruptions quiet, including restoration, and resets the confirmation window", async () => {
    state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
    await checkRiderStatuses(T0);
    for (const offset of [1_000, 40_000]) {
      state.availability = new Map([[1, as("AVAILABLE_SIGNAL_LOST", "signal_lost")]]);
      await checkRiderStatuses(T0 + offset);
      await checkRiderStatuses(T0 + offset + 20_000);
      state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
      await checkRiderStatuses(T0 + offset + 25_000);
    }
    await new Promise((r) => setImmediate(r));
    expect(alerts()).toHaveLength(0);
    expect(createNotification).not.toHaveBeenCalled();
    expect(changes().length).toBeGreaterThan(0);
  });

  it("allows another confirmed outage after the cooldown", async () => {
    for (const offset of [0, 11 * 60_000]) {
      state.availability = new Map([[1, as("AVAILABLE_ONLINE", "online")]]);
      await checkRiderStatuses(T0 + offset);
      state.availability = new Map([[1, as("AVAILABLE_SIGNAL_LOST", "signal_lost")]]);
      await checkRiderStatuses(T0 + offset + 1_000);
      await checkRiderStatuses(T0 + offset + 31_000);
    }
    expect(alerts()).toHaveLength(2);
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
