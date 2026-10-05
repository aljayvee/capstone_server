import { notificationRepository } from "../repositories/notificationRepository.js";
import { notificationFactory } from "./patterns/notificationFactory.js";
import { sendPushNotification } from "../lib/pushNotifications.js";
import { ServiceError } from "./ServiceError.js";
import { eventPublisher } from "../lib/eventPublisher.js";

export async function listForCaller(caller: { id: number; role: string }) {
  if (caller.role === "CUSTOMER") {
    return notificationRepository.findForCustomer(caller.id);
  }
  return notificationRepository.findForUser(caller.id);
}

export async function markAsRead(id: number, caller: { id: number; role: string }) {
  const notification = await notificationRepository.findById(id);
  if (!notification) {
    throw new ServiceError(404, "Notification not found");
  }

  const isOwner =
    (caller.role === "CUSTOMER" && notification.customerId === caller.id) ||
    (caller.role !== "CUSTOMER" && notification.userId === caller.id);
  if (!isOwner) {
    throw new ServiceError(403, "Access denied: this notification isn't yours.");
  }

  return notificationRepository.markRead(id);
}

export async function markAllAsRead(caller: { id: number; role: string }) {
  if (caller.role === "CUSTOMER") {
    return notificationRepository.markAllReadForCustomer(caller.id);
  }
  return notificationRepository.markAllReadForUser(caller.id);
}

// Persists a Notification row AND sends the push in one call — the one real
// trigger point today (rider assignment, see errandService.assignRider) uses
// this instead of calling sendPushNotification directly, so history persists
// instead of being fire-and-forget only. Future trigger points (high-value
// alerts, status updates) should follow the same shape: factory for content,
// this module for persist-then-push.
export async function notifyRiderAssigned(
  rider: { id: number; expoPushToken: string | null },
  errandId: string,
  pickupAddress: string
) {
  const content = notificationFactory.riderAssigned(errandId, pickupAddress);
  await notificationRepository.create({ userId: rider.id, ...content });

  // Fire-and-forget: a push failure must never fail the caller's request —
  // the Notification row above already persisted regardless.
  void sendPushNotification(rider.expoPushToken, {
    title: content.title,
    body: content.body,
    data: { errandId, type: content.type },
    // The rider has 45 seconds to answer. A message Doze is free to sit on until
    // the next maintenance window loses the errand before they ever see it.
    urgent: true,
    // The rider app's "Errand Assignments & Offers" channel (longer vibration),
    // rather than the general one every other alert shares.
    channelId: "orders",
  });
}

/**
 * Tells a customer their errand has been accepted, and by whom.
 *
 * This is the first moment a real person takes responsibility for the request,
 * and it used to be silent: `claimErrand` emitted a socket event and nothing
 * else, so a customer who had navigated away from the waiting screen — or
 * backgrounded the app, which is what people do while waiting — learned about
 * it only by going back and looking.
 *
 * `data.errandId` is what lets the app open the RIGHT conversation when the
 * notification is tapped. A customer can have several errands in flight, so a
 * push that only said "your errand was accepted" would leave them to work out
 * which one.
 */
export async function notifyErrandAccepted(
  customer: { id: number; expoPushToken: string | null },
  errandId: string,
  dispatcherName: string,
  storeSummary: string
) {
  const content = notificationFactory.errandAccepted(dispatcherName, storeSummary);
  await notificationRepository.create({ customerId: customer.id, ...content });

  void sendPushNotification(customer.expoPushToken, {
    title: content.title,
    body: content.body,
    data: { errandId, type: content.type },
  });
}

// Only persists: this one has no push counterpart because a fee change is not
// worth interrupting someone for — it shows up in the in-app panel and on the
// errand itself.
export async function notifyFeeUpdated(customerId: number, errandId: string, totalCost: number) {
  const content = notificationFactory.feeUpdated(errandId, totalCost);
  await notificationRepository.create({ customerId, ...content });
}

/** Tells a customer their errand was declined, and why. */
export async function notifyErrandDeclined(
  customer: { id: number; expoPushToken: string | null },
  errandId: string,
  reason: string
) {
  const content = notificationFactory.errandDeclined(reason);
  await notificationRepository.create({ customerId: customer.id, ...content });

  void sendPushNotification(customer.expoPushToken, {
    title: content.title,
    body: content.body,
    data: { errandId, type: content.type },
  });
}

/**
 * Tells a customer their rider is approaching (within 500m of delivery destination).
 * Persists in MariaDB notifications table and dispatches an Expo push notification.
 */
export async function notifyRiderNearby(
  customer: { id: number; expoPushToken: string | null },
  errandId: string,
  storeSummary: string
) {
  const content = notificationFactory.riderNearby(storeSummary);
  const record = await notificationRepository.create({ customerId: customer.id, ...content });

  void sendPushNotification(customer.expoPushToken, {
    title: content.title,
    body: content.body,
    channelId: "delivery-alerts",
    // One tray entry per delivery: this replaces the "on the way" and
    // "minutes away" alerts before it (deliveryReminderService.tagFor).
    tag: `delivery-${errandId}`,
    data: { errandId, type: content.type },
    urgent: true,
  });

  return record;
}

/**
 * Tells dispatchers that a customer has chatted on an errand.
 * Persists for the assigned dispatcher and broadcasts real-time to all on-duty dispatchers.
 */
export async function notifyDispatcherCustomerChat(
  errandId: string,
  dispatcherId: number | null,
  customerName: string,
  messageSnippet: string
) {
  const content = notificationFactory.customerChat(errandId, customerName, messageSnippet);
  let record = null;
  if (dispatcherId) {
    record = await notificationRepository.create({
      userId: dispatcherId,
      ...content,
    });
  }

  // Real-time broadcast to all active dispatchers so they hear the chime immediately
  eventPublisher.emitToRole("DISPATCHER", "notification:new", {
    id: record?.id || Date.now(),
    type: content.type,
    title: content.title,
    body: content.body,
    errandId,
    createdAt: new Date().toISOString(),
  });

  return record;
}
