import type { NotificationPriority } from "@prisma/client";

/**
 * Every notification the owner and dispatcher bells can hold, how urgent it is
 * and who gets it. The one place a staff notification's priority is decided:
 * call sites name a type and never pick a level themselves.
 *
 * Levels:
 * - CRITICAL: an errand or rider is stuck now and nothing fixes it without a person.
 * - HIGH: a decision is needed soon, or money does not add up; nothing has failed yet.
 * - NORMAL: routine work to look at when convenient.
 * - LOW: for the record; no action.
 *
 * Not saved on purpose (2026-10-21): new errands (the queue is that list),
 * substitute declined, payment refunded, ETA updates, presence, stop arrivals.
 */

export type StaffAudience =
  /** The dispatcher on the errand's latest dispatch log; every active dispatcher when nobody has it yet. */
  | "errandDispatcher"
  /** The errand's dispatcher only; nobody when it has none (chat on an unclaimed errand). */
  | "errandDispatcherOnly"
  /** Every active dispatcher. */
  | "allDispatchers"
  /** The staff account named by the caller (a rider's chat thread with one dispatcher). */
  | "staffUser";

/** "conditional" means the caller decides per event (a rider with errands on hand). */
export type OwnerAudience = "always" | "never" | "conditional";

export interface CatalogEntry {
  priority: NotificationPriority;
  audience: StaffAudience;
  owner: OwnerAudience;
  /** One unread row per (recipient, type, refKey), bumped by each new event. */
  collapse: boolean;
}

export const STAFF_NOTIFICATIONS = {
  ALL_RIDERS_DECLINED: { priority: "CRITICAL", audience: "allDispatchers", owner: "always", collapse: false },
  RIDER_SIGNAL_LOST_PERSISTING: { priority: "CRITICAL", audience: "allDispatchers", owner: "always", collapse: false },
  RIDER_SIGNAL_LOST: { priority: "HIGH", audience: "allDispatchers", owner: "conditional", collapse: false },
  ITEM_OUT_OF_STOCK: { priority: "HIGH", audience: "errandDispatcher", owner: "never", collapse: false },
  RECEIPT_MISMATCH: { priority: "HIGH", audience: "errandDispatcher", owner: "always", collapse: false },
  UNVERIFIED_PURCHASE: { priority: "HIGH", audience: "errandDispatcher", owner: "always", collapse: false },
  STOP_MISMATCH: { priority: "HIGH", audience: "errandDispatcher", owner: "never", collapse: false },
  // HIGH while the rider has errands on hand (the caller overrides), else NORMAL.
  RIDER_CHAT_MESSAGE: { priority: "NORMAL", audience: "staffUser", owner: "never", collapse: true },
  CUSTOMER_CHAT_MESSAGE: { priority: "NORMAL", audience: "errandDispatcherOnly", owner: "never", collapse: true },
  STOP_DELAYED: { priority: "NORMAL", audience: "errandDispatcher", owner: "never", collapse: false },
  RIDER_DECLINED: { priority: "NORMAL", audience: "errandDispatcher", owner: "never", collapse: false },
  RIDER_SIGNAL_RESTORED: { priority: "LOW", audience: "allDispatchers", owner: "conditional", collapse: false },
} as const satisfies Record<string, CatalogEntry>;

export type StaffNotificationType = keyof typeof STAFF_NOTIFICATIONS;

/**
 * Types an owner never sees (owner: "never"): chats, out of stock and the other
 * dispatch-floor traffic (user, 2026-10-21: "not needed for the owner"). Held
 * back even when an owner is the one on the errand or in the rider's thread,
 * and filtered out of an owner's list, so no path can put one in their bell.
 */
export const OWNER_HIDDEN_TYPES: string[] = Object.entries(STAFF_NOTIFICATIONS)
  .filter(([, entry]) => entry.owner === "never")
  .map(([type]) => type);

/**
 * Customer notifications are organised differently from staff ones (user,
 * 2026-10-21): by what they are about, plus whether they wait on the customer.
 * No levels. The category is derived at read time, so it needs no column.
 * Item out of stock stays dispatcher-only.
 */
export type CustomerCategory = "ORDER" | "DELIVERY" | "PAYMENT" | "CHAT";

export interface CustomerCatalogEntry {
  category: CustomerCategory;
  /** Waits on the customer while unread: shown with a "Needs you" chip and its own filter. */
  needsYou: boolean;
  /** One unread row per (customer, type, refKey), bumped by each new event. */
  collapse: boolean;
}

export const CUSTOMER_NOTIFICATIONS = {
  ERRAND_ACCEPTED: { category: "ORDER", needsYou: false, collapse: false },
  RIDER_ASSIGNED: { category: "ORDER", needsYou: false, collapse: false },
  ERRAND_DECLINED: { category: "ORDER", needsYou: true, collapse: false },
  ERRAND_CANCELLED: { category: "ORDER", needsYou: true, collapse: false },
  ERRAND_DELIVERED: { category: "ORDER", needsYou: false, collapse: false },
  RIDER_ON_THE_WAY: { category: "DELIVERY", needsYou: false, collapse: false },
  DELIVERY_HELD: { category: "DELIVERY", needsYou: false, collapse: false },
  // Be at the door with the payment ready.
  RIDER_NEARBY: { category: "DELIVERY", needsYou: true, collapse: false },
  // Push only, never saved (two a run would bury the list); see deliveryReminderService.
  RIDER_ETA_REMINDER: { category: "DELIVERY", needsYou: false, collapse: false },
  FEE_UPDATED: { category: "PAYMENT", needsYou: true, collapse: false },
  PAYMENT_CONFIRMED: { category: "PAYMENT", needsYou: false, collapse: false },
  EXTRA_CHARGE_RESOLVED: { category: "PAYMENT", needsYou: false, collapse: false },
  PAYMENT_REFUNDED: { category: "PAYMENT", needsYou: false, collapse: false },
  CHAT_MESSAGE: { category: "CHAT", needsYou: true, collapse: true },
} as const satisfies Record<string, CustomerCatalogEntry>;

export type CustomerNotificationType = keyof typeof CUSTOMER_NOTIFICATIONS;

const FALLBACK_CUSTOMER_ENTRY: CustomerCatalogEntry = { category: "ORDER", needsYou: false, collapse: false };

export function customerEntry(type: string): CustomerCatalogEntry {
  return (CUSTOMER_NOTIFICATIONS as Record<string, CustomerCatalogEntry>)[type] ?? FALLBACK_CUSTOMER_ENTRY;
}

/**
 * A customer row as the app reads it: its category, whether it needs them, and
 * the errand it opens (from refKey). Older rows without refKey have no errandId.
 * Applied to the list and to every live `notification:new`, so both agree.
 */
export function presentCustomerNotification<T extends { type: string; refKey?: string | null; isRead?: boolean }>(
  row: T
) {
  const entry = customerEntry(row.type);
  const ref = row.refKey ?? "";
  return {
    ...row,
    category: entry.category,
    // Once read, the customer has seen it: it stops waiting on them.
    needsYou: entry.needsYou && !row.isRead,
    errandId: ref.startsWith("errand:") ? ref.slice(7) : undefined,
  };
}

/**
 * Rider notifications (user, 2026-10-22): the ride's statuses only, organised
 * like the customer's, by topic plus "Action needed" (counts while unread).
 * Type names are distinct from staff and customer types, so a row's type alone
 * says whose catalogue it belongs to (notificationRepository.emitNew relies on it).
 */
export type RiderTopic = "OFFER" | "ERRAND" | "PAYMENT" | "CHAT";

export interface RiderCatalogEntry {
  topic: RiderTopic;
  actionNeeded: boolean;
  /** One unread row per (rider, type, refKey), bumped by each new event. */
  collapse: boolean;
}

export const RIDER_NOTIFICATIONS = {
  // Accept or decline within 45 seconds.
  ERRAND_ASSIGNED: { topic: "OFFER", actionNeeded: true, collapse: false },
  OFFER_EXPIRED: { topic: "OFFER", actionNeeded: false, collapse: false },
  // Stop; bring back anything already bought.
  RIDER_ERRAND_CANCELLED: { topic: "ERRAND", actionNeeded: true, collapse: false },
  // The customer approved the list: go and buy.
  ITEMS_CONFIRMED: { topic: "ERRAND", actionNeeded: true, collapse: false },
  ITEMS_UPDATED: { topic: "ERRAND", actionNeeded: true, collapse: false },
  // No substitute for an out-of-stock item: skip it.
  SUBSTITUTE_ANSWERED: { topic: "ERRAND", actionNeeded: true, collapse: false },
  DELIVERY_HELD_RIDER: { topic: "ERRAND", actionNeeded: false, collapse: false },
  RIDER_PAYMENT_CONFIRMED: { topic: "PAYMENT", actionNeeded: false, collapse: false },
  // The extra charge is settled: the items can be handed over.
  RIDER_EXTRA_CHARGE_SETTLED: { topic: "PAYMENT", actionNeeded: true, collapse: false },
  DISPATCHER_CHAT: { topic: "CHAT", actionNeeded: true, collapse: true },
} as const satisfies Record<string, RiderCatalogEntry>;

export type RiderNotificationType = keyof typeof RIDER_NOTIFICATIONS;

export function isRiderNotificationType(type: string): type is RiderNotificationType {
  return Object.prototype.hasOwnProperty.call(RIDER_NOTIFICATIONS, type);
}

/** A rider row as the app reads it: topic, action needed, and what it opens (errand or dispatcher chat). */
export function presentRiderNotification<T extends { type: string; refKey?: string | null; isRead?: boolean }>(row: T) {
  const entry: RiderCatalogEntry = isRiderNotificationType(row.type)
    ? RIDER_NOTIFICATIONS[row.type]
    : { topic: "ERRAND", actionNeeded: false, collapse: false };
  const ref = row.refKey ?? "";
  return {
    ...row,
    topic: entry.topic,
    actionNeeded: entry.actionNeeded && !row.isRead,
    errandId: ref.startsWith("errand:") ? ref.slice(7) : undefined,
    dispatcherId: ref.startsWith("dispatcher:") ? Number(ref.slice(11)) || undefined : undefined,
  };
}

export const dispatcherRef = (dispatcherId: number | string) => `dispatcher:${dispatcherId}`;

export const PRIORITY_RANK: Record<NotificationPriority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 };

export const errandRef = (errandId: string) => `errand:${errandId}`;
export const riderRef = (riderId: number | string) => `rider:${riderId}`;
