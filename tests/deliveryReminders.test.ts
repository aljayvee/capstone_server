import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, findErrand, findCustomer, markSent, createNotification, notifyNearby, routeWith, getFresh } =
  vi.hoisted(() => ({
    send: vi.fn(),
    findErrand: vi.fn(),
    findCustomer: vi.fn(),
    markSent: vi.fn(),
    createNotification: vi.fn(),
    notifyNearby: vi.fn(),
    routeWith: vi.fn(),
    getFresh: vi.fn(),
  }));

vi.mock("../src/lib/pushNotifications.js", () => ({ sendPushNotification: send }));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findById: findErrand, markProximityAlertSent: markSent },
}));
vi.mock("../src/repositories/customerRepository.js", () => ({ customerRepository: { findById: findCustomer } }));
vi.mock("../src/repositories/notificationRepository.js", () => ({
  notificationRepository: { create: createNotification },
}));
vi.mock("../src/services/notificationService.js", () => ({ notifyRiderNearby: notifyNearby }));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emitToCustomer: vi.fn(), emitToErrand: vi.fn() },
}));
vi.mock("../src/lib/routing/resilientRoutingService.js", () => ({ routeWith }));
vi.mock("../src/lib/riderPositionStore.js", () => ({ getFresh }));

import {
  __resetDeliveryReminders,
  notifyOnTheWay,
  onDeliveryEta,
  onRiderPosition,
  reminderDue,
} from "../src/services/deliveryReminderService.js";

const CUSTOMER = { latitude: 6.6834683, longitude: 124.663931 };
const errand = (overrides: Record<string, unknown> = {}) => ({
  id: "e-1",
  status: "IN_TRANSIT",
  riderId: 3,
  customerId: 9,
  itemsPurchasedAt: new Date(),
  deliveryLatitude: CUSTOMER.latitude,
  deliveryLongitude: CUSTOMER.longitude,
  rider: { firstName: "Renen" },
  pinpoints: [{ storeName: "Julie's Bakeshop" }],
  ...overrides,
});

beforeEach(() => {
  __resetDeliveryReminders();
  for (const fn of [send, findErrand, findCustomer, markSent, createNotification, notifyNearby, routeWith, getFresh]) {
    fn.mockReset();
  }
  findErrand.mockResolvedValue(errand());
  findCustomer.mockResolvedValue({ id: 9, expoPushToken: "fcm-token" });
  createNotification.mockResolvedValue({ id: 1 });
  notifyNearby.mockResolvedValue({ id: 2, title: "t", body: "b" });
  getFresh.mockReturnValue({ point: { latitude: 6.69, longitude: 124.67 } });
  routeWith.mockResolvedValue({ durationSeconds: 14 * 60, degraded: false });
});

describe("reminderDue", () => {
  it("reminds at 10 and then 5 minutes, once each", () => {
    const state = { initialMinutes: 20, sent: new Set<number>() };
    expect(reminderDue(15, state)).toBeNull();
    expect(reminderDue(10, state)).toBe(10);
    expect(reminderDue(9, state)).toBeNull();
    expect(reminderDue(5, state)).toBe(5);
    expect(reminderDue(3, state)).toBeNull();
  });

  it("sends one reminder, not two, when the ETA drops past both at once", () => {
    const state = { initialMinutes: 20, sent: new Set<number>() };
    expect(reminderDue(4, state)).toBe(5);
    expect(reminderDue(3, state)).toBeNull();
  });

  it("skips a threshold the run already started inside", () => {
    // "On the way, about 8 min" was the first push: no "10 minutes" after it.
    const state = { initialMinutes: 8, sent: new Set<number>() };
    expect(reminderDue(8, state)).toBeNull();
    expect(reminderDue(5, state)).toBe(5);
  });
});

describe("notifyOnTheWay", () => {
  it("pushes who is coming and roughly when, to the delivery channel, tagged per errand", async () => {
    await notifyOnTheWay("e-1");
    expect(send).toHaveBeenCalledTimes(1);
    const [token, payload] = send.mock.calls[0];
    expect(token).toBe("fcm-token");
    expect(payload).toMatchObject({
      title: "Your order is on the way",
      channelId: "delivery-alerts",
      tag: "delivery-e-1",
      urgent: true,
      data: { errandId: "e-1", type: "RIDER_ON_THE_WAY" },
    });
    expect(payload.body).toBe("Renen bought everything and is heading to you. About 14 min away.");
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it("still tells the customer when the rider's position is not known", async () => {
    getFresh.mockReturnValue(undefined);
    await notifyOnTheWay("e-1");
    expect(send.mock.calls[0][1].body).toBe("Renen bought everything and is heading to you.");
  });

  it("stays silent for an errand that is not out for delivery", async () => {
    findErrand.mockResolvedValue(errand({ status: "DELIVERED" }));
    await notifyOnTheWay("e-1");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("onDeliveryEta", () => {
  it("reminds the customer as the rider gets close, after the on-the-way push", async () => {
    await notifyOnTheWay("e-1"); // 14 min at the start
    send.mockClear();
    await onDeliveryEta(errand(), 9 * 60, 0);
    expect(send.mock.calls[0][1]).toMatchObject({
      title: "Your rider is getting close",
      body: "About 9 min away. Please get ready to receive your order.",
      tag: "delivery-e-1",
    });
  });

  it("says nothing while the rider is still shopping", async () => {
    await onDeliveryEta(errand({ itemsPurchasedAt: null }), 3 * 60, 1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("onRiderPosition", () => {
  it("sends the almost-there alert once within 500 m, from the live position", async () => {
    markSent.mockResolvedValue({ count: 1 });
    const near = { latitude: CUSTOMER.latitude + 0.002, longitude: CUSTOMER.longitude }; // ~220 m
    await onRiderPosition(errand(), near);
    await onRiderPosition(errand(), near);
    expect(markSent).toHaveBeenCalledTimes(1);
    expect(notifyNearby).toHaveBeenCalledTimes(1);
  });

  it("does not fire far away, or while the rider is still shopping near the customer", async () => {
    await onRiderPosition(errand(), { latitude: 6.72, longitude: 124.66 });
    await onRiderPosition(errand({ itemsPurchasedAt: null }), CUSTOMER);
    expect(markSent).not.toHaveBeenCalled();
  });
});
