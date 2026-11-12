import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, bump, findUnreadForCustomer, push, emitToCustomer } = vi.hoisted(() => ({
  create: vi.fn(async (data: any) => ({ id: 501, userId: null, isRead: false, createdAt: new Date(), ...data })),
  bump: vi.fn(async (id: number, data: any) => ({ id, userId: null, customerId: 3, isRead: false, ...data })),
  findUnreadForCustomer: vi.fn(async (..._args: any[]) => null as any),
  push: vi.fn(async () => undefined),
  emitToCustomer: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { user: { findMany: vi.fn(async () => []) } } }));
vi.mock("../src/lib/pushNotifications.js", () => ({ sendPushNotification: push }));
vi.mock("../src/lib/errandReference.js", () => ({ referenceLabel: vi.fn(async () => "261021-ABCDE-0001") }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emitToRole: vi.fn(), emitToUser: vi.fn(), emitToCustomer },
}));

import { notificationRepository } from "../src/repositories/notificationRepository.js";
import {
  deliverToCustomer,
  listForCaller,
  notifyCustomer,
  notifyErrandAccepted,
} from "../src/services/notificationService.js";
import { CUSTOMER_NOTIFICATIONS, presentCustomerNotification } from "../src/services/notificationCatalog.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(notificationRepository, "create").mockImplementation(create as any);
  vi.spyOn(notificationRepository, "bump").mockImplementation(bump as any);
  vi.spyOn(notificationRepository, "findUnreadByRefForCustomer").mockImplementation(findUnreadForCustomer as any);
  findUnreadForCustomer.mockImplementation(async () => null);
});

describe("customer catalogue", () => {
  it("files every customer type under one of the four categories", () => {
    for (const entry of Object.values(CUSTOMER_NOTIFICATIONS)) {
      expect(["ORDER", "DELIVERY", "PAYMENT", "CHAT"]).toContain(entry.category);
    }
  });

  it("does not carry item out of stock (dispatcher only)", () => {
    expect(CUSTOMER_NOTIFICATIONS).not.toHaveProperty("ITEM_OUT_OF_STOCK");
  });

  it("presents a row with its category, needsYou and errand", () => {
    expect(presentCustomerNotification({ type: "FEE_UPDATED", refKey: "errand:e-1", isRead: false })).toMatchObject({
      category: "PAYMENT",
      needsYou: true,
      errandId: "e-1",
    });
  });

  it("stops needing the customer once read", () => {
    expect(presentCustomerNotification({ type: "CHAT_MESSAGE", refKey: "errand:e-1", isRead: true }).needsYou).toBe(false);
  });

  it("gives an older row with no link no errandId, and an unknown type the Order category", () => {
    expect(presentCustomerNotification({ type: "SOMETHING_OLD", refKey: null })).toMatchObject({
      category: "ORDER",
      needsYou: false,
      errandId: undefined,
    });
  });
});

describe("deliverToCustomer", () => {
  it("links the row to its errand", async () => {
    await deliverToCustomer(3, "RIDER_ON_THE_WAY", { title: "t", body: "b" }, "e-1");
    expect(create).toHaveBeenCalledWith({ customerId: 3, type: "RIDER_ON_THE_WAY", title: "t", body: "b", refKey: "errand:e-1" });
  });

  it("folds the next chat message into the unread row for that errand", async () => {
    findUnreadForCustomer.mockImplementation(async () => ({ id: 77, title: "Message from Ana" }));
    await deliverToCustomer(3, "CHAT_MESSAGE", { title: "Message from Ana", body: "Nasa store na po" }, "e-1");
    expect(findUnreadForCustomer).toHaveBeenCalledWith(3, "CHAT_MESSAGE", "errand:e-1");
    expect(create).not.toHaveBeenCalled();
    expect(bump).toHaveBeenCalledWith(77, { title: "Message from Ana (2 new)", body: "Nasa store na po" });
  });

  it("does not fold a type that does not collapse", async () => {
    findUnreadForCustomer.mockImplementation(async () => ({ id: 77, title: "x" }));
    await deliverToCustomer(3, "FEE_UPDATED", { title: "t", body: "b" }, "e-1");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("notifyCustomer", () => {
  it("writes the row and sends the push with the errand and type", async () => {
    await notifyCustomer({ id: 3, expoPushToken: "tok" }, "ERRAND_DELIVERED", { title: "t", body: "b" }, "e-1");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "ERRAND_DELIVERED", refKey: "errand:e-1" }));
    expect(push).toHaveBeenCalledWith("tok", expect.objectContaining({ data: { errandId: "e-1", type: "ERRAND_DELIVERED" } }));
  });

  it("never throws into the caller", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    await expect(
      notifyCustomer({ id: 3, expoPushToken: null }, "PAYMENT_REFUNDED", { title: "t", body: "b" }, "e-1")
    ).resolves.toBeNull();
  });
});

describe("existing customer notifications now carry their errand", () => {
  it("ERRAND_ACCEPTED is linked", async () => {
    await notifyErrandAccepted({ id: 3, expoPushToken: null }, "e-9", "Ana", "Gaisano");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "ERRAND_ACCEPTED", refKey: "errand:e-9" }));
  });
});

describe("customer list", () => {
  it("returns every row presented the way the app reads it", async () => {
    vi.spyOn(notificationRepository, "findForCustomer").mockResolvedValue([
      { id: 1, type: "RIDER_NEARBY", title: "t", body: "b", isRead: false, refKey: "errand:e-1" },
    ] as any);
    const { items } = await listForCaller({ id: 3, role: "CUSTOMER" });
    expect(items[0]).toMatchObject({ category: "DELIVERY", needsYou: true, errandId: "e-1" });
  });
});
