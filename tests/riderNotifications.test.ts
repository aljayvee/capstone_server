import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, bump, findUnread, push, findErrand, findUser } = vi.hoisted(() => ({
  create: vi.fn(async (data: any) => ({ id: 801, customerId: null, isRead: false, createdAt: new Date(), ...data })),
  bump: vi.fn(async (id: number, data: any) => ({ id, userId: 12, isRead: false, ...data })),
  findUnread: vi.fn(async (..._args: any[]) => null as any),
  push: vi.fn(async () => undefined),
  findErrand: vi.fn(async (..._args: any[]) => ({ riderId: 12 }) as any),
  findUser: vi.fn(async (..._args: any[]) => ({ id: 12, expoPushToken: "rider-token" }) as any),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errand: { findUnique: findErrand },
    user: { findUnique: findUser, findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../src/lib/pushNotifications.js", () => ({ sendPushNotification: push }));
vi.mock("../src/lib/errandReference.js", () => ({ referenceLabel: vi.fn(async () => "261022-ABCDE-0001") }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emitToRole: vi.fn(), emitToUser: vi.fn(), emitToCustomer: vi.fn() },
}));

import { notificationRepository } from "../src/repositories/notificationRepository.js";
import {
  deliverToRider,
  listForCaller,
  notifyErrandRider,
  notifyRiderAssigned,
} from "../src/services/notificationService.js";
import {
  RIDER_NOTIFICATIONS,
  STAFF_NOTIFICATIONS,
  CUSTOMER_NOTIFICATIONS,
  presentRiderNotification,
} from "../src/services/notificationCatalog.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(notificationRepository, "create").mockImplementation(create as any);
  vi.spyOn(notificationRepository, "bump").mockImplementation(bump as any);
  vi.spyOn(notificationRepository, "findUnreadByRef").mockImplementation(findUnread as any);
  findUnread.mockImplementation(async () => null);
  findErrand.mockImplementation(async () => ({ riderId: 12 }));
});

const rows = () => create.mock.calls.map((c: any[]) => c[0]);

describe("rider catalogue", () => {
  it("files every rider type under one of the four topics", () => {
    for (const entry of Object.values(RIDER_NOTIFICATIONS)) {
      expect(["OFFER", "ERRAND", "PAYMENT", "CHAT"]).toContain(entry.topic);
    }
  });

  it("shares no type name with the staff or customer catalogues", () => {
    for (const type of Object.keys(RIDER_NOTIFICATIONS)) {
      expect(STAFF_NOTIFICATIONS).not.toHaveProperty(type);
      expect(CUSTOMER_NOTIFICATIONS).not.toHaveProperty(type);
    }
  });

  it("presents topic, action needed while unread, and what the row opens", () => {
    expect(presentRiderNotification({ type: "ITEMS_CONFIRMED", refKey: "errand:e-1", isRead: false })).toMatchObject({
      topic: "ERRAND",
      actionNeeded: true,
      errandId: "e-1",
    });
    expect(presentRiderNotification({ type: "DISPATCHER_CHAT", refKey: "dispatcher:7", isRead: true })).toMatchObject({
      topic: "CHAT",
      actionNeeded: false,
      dispatcherId: 7,
    });
  });
});

describe("deliverToRider", () => {
  it("links the offer to its errand", async () => {
    await notifyRiderAssigned({ id: 12, expoPushToken: null }, "e-1", "Gaisano");
    expect(rows()[0]).toMatchObject({ userId: 12, type: "ERRAND_ASSIGNED", refKey: "errand:e-1" });
  });

  it("folds the next dispatcher message into the unread row for that dispatcher", async () => {
    findUnread.mockImplementation(async () => ({ id: 55, title: "Message from Ana" }));
    await deliverToRider(12, "DISPATCHER_CHAT", { title: "Message from Ana", body: "Nasa store ka na?" }, "dispatcher:7");
    expect(findUnread).toHaveBeenCalledWith(12, "DISPATCHER_CHAT", "dispatcher:7");
    expect(create).not.toHaveBeenCalled();
    expect(bump).toHaveBeenCalledWith(55, { title: "Message from Ana (2 new)", body: "Nasa store ka na?" });
  });
});

describe("notifyErrandRider", () => {
  it("tells the errand's current rider, linked, with a push", async () => {
    await notifyErrandRider("e-1", "ITEMS_UPDATED", (errand) => ({ title: "Items list changed", body: `${errand}: x` }));
    expect(rows()[0]).toMatchObject({ userId: 12, type: "ITEMS_UPDATED", refKey: "errand:e-1", body: "Errand 261022-ABCDE-0001: x" });
    expect(push).toHaveBeenCalledWith("rider-token", expect.objectContaining({ data: { type: "ITEMS_UPDATED", errandId: "e-1" } }));
  });

  it("tells a named rider even after they were taken off the errand (offer expired)", async () => {
    findErrand.mockImplementation(async () => ({ riderId: null }));
    await notifyErrandRider("e-1", "OFFER_EXPIRED", () => ({ title: "t", body: "b" }), { riderId: 12 });
    expect(rows()[0]).toMatchObject({ userId: 12, type: "OFFER_EXPIRED" });
  });

  it("does not tell a rider about their own cancellation", async () => {
    await notifyErrandRider("e-1", "RIDER_ERRAND_CANCELLED", () => ({ title: "t", body: "b" }), {
      riderId: 12,
      exceptRiderId: 12,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("does nothing for an errand with no rider", async () => {
    findErrand.mockImplementation(async () => ({ riderId: null }));
    await notifyErrandRider("e-1", "ITEMS_CONFIRMED", () => ({ title: "t", body: "b" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("never throws into the caller", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    await expect(notifyErrandRider("e-1", "ITEMS_UPDATED", () => ({ title: "t", body: "b" }))).resolves.toBeNull();
  });
});

describe("rider list", () => {
  it("comes back presented, paged or not", async () => {
    vi.spyOn(notificationRepository, "findForUser").mockResolvedValue([
      { id: 1, type: "ERRAND_ASSIGNED", title: "t", body: "b", isRead: false, refKey: "errand:e-1" },
    ] as any);
    const { items } = await listForCaller({ id: 12, role: "RIDER" });
    expect(items[0]).toMatchObject({ topic: "OFFER", actionNeeded: true, errandId: "e-1" });
  });

  it("leaves a dispatcher's rows as stored", async () => {
    vi.spyOn(notificationRepository, "findForUser").mockResolvedValue([
      { id: 2, type: "RIDER_SIGNAL_LOST", title: "t", body: "b", isRead: false, refKey: "rider:3" },
    ] as any);
    const { items } = await listForCaller({ id: 7, role: "DISPATCHER" });
    expect(items[0]).not.toHaveProperty("topic");
  });
});
