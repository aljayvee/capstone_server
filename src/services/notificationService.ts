import { notificationRepository } from "../repositories/notificationRepository.js";
import { notificationFactory } from "./patterns/notificationFactory.js";
import { sendPushNotification } from "../lib/pushNotifications.js";
import { ServiceError } from "./ServiceError.js";

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
  });
}

// Customers have no push token in this schema (CustomerAccount, unlike
// User, doesn't collect one) — the in-app notification panel Phase 5 built
// for CustomerApp is the only delivery channel here, so this only persists.
export async function notifyFeeUpdated(customerId: number, errandId: string, totalCost: number) {
  const content = notificationFactory.feeUpdated(errandId, totalCost);
  await notificationRepository.create({ customerId, ...content });
}
