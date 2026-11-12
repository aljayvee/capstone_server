import type { NotificationPriority } from "@prisma/client";
import {
  notificationRepository,
  type NotificationListQuery,
  type NotificationSort,
} from "../repositories/notificationRepository.js";
import { dispatchLogRepository } from "../repositories/errandRepository.js";
import { notificationFactory } from "./patterns/notificationFactory.js";
import { sendPushNotification } from "../lib/pushNotifications.js";
import { ServiceError } from "./ServiceError.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { referenceLabel } from "../lib/errandReference.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  OWNER_HIDDEN_TYPES,
  STAFF_NOTIFICATIONS,
  customerEntry,
  errandRef,
  presentCustomerNotification,
  presentRiderNotification,
  RIDER_NOTIFICATIONS,
  type CustomerNotificationType,
  type RiderNotificationType,
  type StaffNotificationType,
} from "./notificationCatalog.js";

const PRIORITIES: NotificationPriority[] = ["LOW", "NORMAL", "HIGH", "CRITICAL"];
const SORTS: NotificationSort[] = ["newest", "oldest", "priority"];
const LIST_PARAMS = ["q", "sort", "priority", "unread", "type", "limit", "offset"];

/**
 * A staff bell's query string, made safe. Returns null when the caller sent no
 * list parameter at all: that caller (the rider app, an older portal) gets every
 * row as before. A bad value falls back to its default rather than refusing.
 */
export function parseListQuery(raw: Record<string, unknown>): NotificationListQuery | null {
  if (!LIST_PARAMS.some((key) => raw[key] !== undefined)) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const list = (value: unknown) =>
    text(value)
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean);
  const int = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number.parseInt(text(value), 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  };

  const sort = text(raw.sort).toLowerCase() as NotificationSort;
  const q = text(raw.q).trim().slice(0, 80);
  const priorities = list(raw.priority).filter((p): p is NotificationPriority =>
    PRIORITIES.includes(p as NotificationPriority)
  );
  const types = list(raw.type).filter((t) => /^[A-Z_]{1,64}$/.test(t));

  return {
    q: q || undefined,
    sort: SORTS.includes(sort) ? sort : "newest",
    priorities: priorities.length ? priorities : undefined,
    types: types.length ? types : undefined,
    unreadOnly: text(raw.unread) === "1" || text(raw.unread) === "true",
    limit: int(raw.limit, 50, 1, 100),
    offset: int(raw.offset, 0, 0, 100_000),
  };
}

/** `total` is set only for a paged staff list; the controller sends it as X-Total-Count. */
export async function listForCaller(
  caller: { id: number; role: string },
  query: NotificationListQuery | null = null
): Promise<{ items: unknown[]; total?: number }> {
  if (caller.role === "CUSTOMER") {
    const rows = await notificationRepository.findForCustomer(caller.id);
    return { items: rows.map((row) => presentCustomerNotification(row)) };
  }
  const excludeTypes = caller.role === "OWNER" ? OWNER_HIDDEN_TYPES : [];
  // A rider's rows come back presented (topic, actionNeeded, errandId), like a customer's.
  const present = caller.role === "RIDER" ? (rows: any[]) => rows.map((row) => presentRiderNotification(row)) : (rows: any[]) => rows;
  if (!query) {
    return { items: present(await notificationRepository.findForUser(caller.id, excludeTypes)) };
  }
  const page = await notificationRepository.findPageForUser(caller.id, { ...query, excludeTypes });
  return { items: present(page.items), total: page.total };
}

// ── Staff notifications (owner and dispatcher bells) ───────────────────────

/** Column limits: title and body are VARCHAR(191). */
const clip = (value: string, max = 191) => (value.length > max ? `${value.slice(0, max - 3)}...` : value);

const COLLAPSE_COUNT = /\s\((\d+) new\)$/;

export interface StaffContent {
  title: string;
  body: string;
}

/**
 * Writes one row per recipient. A collapsing type (chat) folds into that
 * recipient's unread row for the same refKey instead, so a conversation is one
 * row that keeps its latest line, not a row per message.
 */
export async function deliverToStaff(
  userIds: number[],
  type: StaffNotificationType,
  content: StaffContent,
  refKey: string | null,
  priority: NotificationPriority = STAFF_NOTIFICATIONS[type].priority
) {
  const entry = STAFF_NOTIFICATIONS[type];
  let unique = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
  const body = clip(content.body);

  // An owner can still be the one on an errand, or in a rider's thread. A type
  // owners never get is held back from them all the same.
  if (entry.owner === "never" && unique.length) {
    const owners = await prisma.user.findMany({
      where: { id: { in: unique }, role: "OWNER" },
      select: { id: true },
    });
    const ownerIds = new Set(owners.map((o) => o.id));
    unique = unique.filter((id) => !ownerIds.has(id));
  }

  return Promise.all(
    unique.map(async (userId) => {
      if (entry.collapse && refKey) {
        const open = await notificationRepository.findUnreadByRef(userId, type, refKey);
        if (open) {
          const count = Number(open.title.match(COLLAPSE_COUNT)?.[1] ?? 1) + 1;
          return notificationRepository.bump(open.id, {
            title: `${clip(content.title, 176)} (${count} new)`,
            body,
            priority,
          });
        }
      }
      return notificationRepository.create({
        userId,
        type,
        title: clip(content.title),
        body,
        priority,
        refKey,
      });
    })
  );
}

const activeStaffIds = async (role: "DISPATCHER" | "OWNER") =>
  (await prisma.user.findMany({ where: { role, status: "Active" }, select: { id: true } })).map((u) => u.id);

/**
 * Remembers which one-off events were already told, so a check that runs every
 * minute (a stalled stop) notifies once. In memory: a restart may repeat one.
 */
const toldOnce = new Map<string, number>();
const ONCE_TTL_MS = 24 * 60 * 60 * 1000;

function firstTime(key: string, now = Date.now()): boolean {
  if (toldOnce.has(key)) return false;
  toldOnce.set(key, now);
  if (toldOnce.size > 5000) {
    for (const [k, at] of toldOnce) if (now - at > ONCE_TTL_MS) toldOnce.delete(k);
  }
  return true;
}

export interface NotifyStaffOptions {
  errandId?: string;
  /** Required for the "staffUser" audience. */
  staffUserId?: number;
  /** For an owner audience of "conditional". */
  includeOwners?: boolean;
  priority?: NotificationPriority;
  refKey?: string;
  /** Notify at most once per key (see firstTime). */
  onceKey?: string;
}

/**
 * The one way the server tells owners and dispatchers something worth keeping.
 * Recipients and priority come from notificationCatalog.ts. Never throws: a
 * notification that cannot be written must not fail the work that raised it.
 */
export async function notifyStaff(
  type: StaffNotificationType,
  content: StaffContent,
  options: NotifyStaffOptions = {}
): Promise<number[]> {
  try {
    if (options.onceKey && !firstTime(`${type}:${options.onceKey}`)) return [];
    const entry = STAFF_NOTIFICATIONS[type];
    const recipients: number[] = [];

    switch (entry.audience) {
      case "allDispatchers":
        recipients.push(...(await activeStaffIds("DISPATCHER")));
        break;
      case "staffUser":
        if (options.staffUserId) recipients.push(options.staffUserId);
        break;
      case "errandDispatcher":
      case "errandDispatcherOnly": {
        const log = options.errandId ? await dispatchLogRepository.findLatestByErrandId(options.errandId) : null;
        if (log?.dispatcherId) recipients.push(log.dispatcherId);
        else if (entry.audience === "errandDispatcher") recipients.push(...(await activeStaffIds("DISPATCHER")));
        break;
      }
    }

    if (entry.owner === "always" || (entry.owner === "conditional" && options.includeOwners)) {
      recipients.push(...(await activeStaffIds("OWNER")));
    }

    const refKey = options.refKey ?? (options.errandId ? errandRef(options.errandId) : null);
    const rows = await deliverToStaff(recipients, type, content, refKey, options.priority ?? entry.priority);
    return rows.map((row) => row.userId).filter((id): id is number => id !== null);
  } catch (error) {
    logger.error(`Could not write ${type} notification:`, error);
    return [];
  }
}

/**
 * notifyStaff for an errand event, with the errand's label resolved first.
 * Fire and forget at the call site (`void notifyStaffAboutErrand(...)`); never throws.
 */
export async function notifyStaffAboutErrand(
  type: StaffNotificationType,
  errandId: string,
  build: (errand: string) => StaffContent,
  options: Omit<NotifyStaffOptions, "errandId"> = {}
): Promise<number[]> {
  try {
    return await notifyStaff(type, build(await errandLabel(errandId)), { ...options, errandId });
  } catch (error) {
    logger.error(`Could not write ${type} notification for ${errandId}:`, error);
    return [];
  }
}

/** "Errand 261019-1UUID-0007" for a sentence, never the raw id. */
export async function errandLabel(errandId: string): Promise<string> {
  return `Errand ${await referenceLabel(errandId)}`;
}

/** A rider's name for a sentence, or "The rider" when it cannot be read. */
export async function riderName(riderId: number): Promise<string> {
  const rider = await prisma.user
    .findUnique({ where: { id: riderId }, select: { firstName: true, lastName: true } })
    .catch(() => null);
  return `${rider?.firstName ?? ""} ${rider?.lastName ?? ""}`.trim() || "The rider";
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
  const content = notificationFactory.riderAssigned(await referenceLabel(errandId), pickupAddress);
  await deliverToRider(rider.id, "ERRAND_ASSIGNED", content, errandRef(errandId));

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

// ── Rider notifications ────────────────────────────────────────────────────

/**
 * Writes one rider row with its link (`errand:<id>` or `dispatcher:<id>`), so a
 * tap in the rider app opens it. A collapsing type (dispatcher chat) folds into
 * the rider's unread row for that conversation instead. The repository emits it
 * presented; callers do not re-emit.
 */
export async function deliverToRider(
  riderId: number,
  type: RiderNotificationType,
  content: StaffContent,
  refKey: string | null
) {
  const body = clip(content.body);
  if (RIDER_NOTIFICATIONS[type].collapse && refKey) {
    const open = await notificationRepository.findUnreadByRef(riderId, type, refKey);
    if (open) {
      const count = Number(open.title.match(COLLAPSE_COUNT)?.[1] ?? 1) + 1;
      return notificationRepository.bump(open.id, { title: `${clip(content.title, 176)} (${count} new)`, body });
    }
  }
  return notificationRepository.create({ userId: riderId, type, title: clip(content.title), body, refKey });
}

/**
 * A rider row plus its push, for the ride statuses added on 2026-10-22. Never
 * throws: telling the rider must not fail the work that raised it.
 */
export async function notifyRider(
  rider: { id: number; expoPushToken: string | null },
  type: RiderNotificationType,
  content: StaffContent,
  refKey: string | null,
  push: { channelId?: string; tag?: string; urgent?: boolean; data?: Record<string, unknown> } = {}
) {
  try {
    const record = await deliverToRider(rider.id, type, content, refKey);
    const errandId = refKey?.startsWith("errand:") ? refKey.slice(7) : undefined;
    void sendPushNotification(rider.expoPushToken, {
      title: content.title,
      body: content.body,
      channelId: push.channelId,
      tag: push.tag,
      urgent: push.urgent,
      data: { type, ...(errandId ? { errandId } : {}), ...(push.data ?? {}) },
    });
    return record;
  } catch (error) {
    logger.error(`Could not write ${type} notification for rider ${rider.id}:`, error);
    return null;
  }
}

/** notifyRider for an errand's current rider, looked up here. Skips quietly when there is none. */
export async function notifyErrandRider(
  errandId: string,
  type: RiderNotificationType,
  build: (errand: string) => StaffContent,
  options: { exceptRiderId?: number | null; riderId?: number | null; push?: { channelId?: string; urgent?: boolean } } = {}
) {
  try {
    const riderId =
      options.riderId ??
      (await prisma.errand.findUnique({ where: { id: errandId }, select: { riderId: true } }))?.riderId ??
      null;
    if (!riderId || riderId === options.exceptRiderId) return null;
    const rider = await prisma.user.findUnique({ where: { id: riderId }, select: { id: true, expoPushToken: true } });
    if (!rider) return null;
    return await notifyRider(rider, type, build(await errandLabel(errandId)), errandRef(errandId), options.push);
  } catch (error) {
    logger.error(`Could not tell the rider ${type} for errand ${errandId}:`, error);
    return null;
  }
}

// ── Customer notifications ─────────────────────────────────────────────────

/**
 * Writes one customer row, linked to its errand (refKey), so a tap in the app
 * opens it. A collapsing type (chat) folds into the customer's unread row for
 * that errand instead: "(N new)" and the latest line, same id. The repository
 * emits it, presented (category, needsYou, errandId); callers do not re-emit.
 */
export async function deliverToCustomer(
  customerId: number,
  type: CustomerNotificationType,
  content: StaffContent,
  errandId: string | null
) {
  const refKey = errandId ? errandRef(errandId) : null;
  const body = clip(content.body);
  if (customerEntry(type).collapse && refKey) {
    const open = await notificationRepository.findUnreadByRefForCustomer(customerId, type, refKey);
    if (open) {
      const count = Number(open.title.match(COLLAPSE_COUNT)?.[1] ?? 1) + 1;
      return notificationRepository.bump(open.id, { title: `${clip(content.title, 176)} (${count} new)`, body });
    }
  }
  return notificationRepository.create({ customerId, type, title: clip(content.title), body, refKey });
}

/**
 * A customer row plus its push, for the milestones added on 2026-10-21. Never
 * throws: telling the customer must not fail the work that raised it.
 */
export async function notifyCustomer(
  customer: { id: number; expoPushToken: string | null },
  type: CustomerNotificationType,
  content: StaffContent,
  errandId: string,
  push: { channelId?: string; tag?: string; urgent?: boolean } = {}
) {
  try {
    const record = await deliverToCustomer(customer.id, type, content, errandId);
    void sendPushNotification(customer.expoPushToken, {
      title: content.title,
      body: content.body,
      data: { errandId, type },
      ...push,
    });
    return record;
  } catch (error) {
    logger.error(`Could not write ${type} notification for errand ${errandId}:`, error);
    return null;
  }
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
  await deliverToCustomer(customer.id, "ERRAND_ACCEPTED", content, errandId);

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
  const content = notificationFactory.feeUpdated(await referenceLabel(errandId), totalCost);
  await deliverToCustomer(customerId, "FEE_UPDATED", content, errandId);
}

/** Tells a customer their errand was declined, and why. */
export async function notifyErrandDeclined(
  customer: { id: number; expoPushToken: string | null },
  errandId: string,
  reason: string
) {
  const content = notificationFactory.errandDeclined(reason);
  await deliverToCustomer(customer.id, "ERRAND_DECLINED", content, errandId);

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
  const record = await deliverToCustomer(customer.id, "RIDER_NEARBY", content, errandId);

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
  const content = notificationFactory.customerChat(await referenceLabel(errandId), customerName, messageSnippet);
  let record = null;
  if (dispatcherId) {
    // One unread row per conversation (catalog collapse), bumped per message.
    [record] = await deliverToStaff([dispatcherId], "CUSTOMER_CHAT_MESSAGE", content, errandRef(errandId));
  }

  // Real-time broadcast to all active dispatchers so they hear the chime immediately.
  // `ephemeral`: no row stands behind it, so the bell must not list it (the
  // dispatcher who has the errand already got the saved row above).
  eventPublisher.emitToRole("DISPATCHER", "notification:new", {
    id: record?.id || Date.now(),
    type: content.type,
    title: content.title,
    body: content.body,
    errandId,
    priority: STAFF_NOTIFICATIONS.CUSTOMER_CHAT_MESSAGE.priority,
    refKey: errandRef(errandId),
    ephemeral: true,
    createdAt: new Date().toISOString(),
  });

  return record;
}
