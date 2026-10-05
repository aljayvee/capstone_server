import { errandRepository } from "../repositories/errandRepository.js";
import { customerRepository } from "../repositories/customerRepository.js";
import { notificationRepository } from "../repositories/notificationRepository.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { sendPushNotification } from "../lib/pushNotifications.js";
import * as riderPositionStore from "../lib/riderPositionStore.js";
import * as resilient from "../lib/routing/resilientRoutingService.js";
import { riderChoiceFor } from "../lib/routing/riderRouteChoice.js";
import { haversineDistanceKm } from "../lib/geo.js";
import { logger } from "../lib/logger.js";
import * as notificationService from "./notificationService.js";

/**
 * The customer's pushes for the delivery run: the stretch after the rider has
 * bought everything and is riding to them.
 *
 * Nothing is pushed while the rider is still shopping; the Track tab shows the
 * ETA to the store and nothing else then. From "items bought" on:
 *
 * 1. **On the way** (the moment the items are marked bought): who is coming and
 *    about how long they will be.
 * 2. **About 10 min / about 5 min** (from the live ETA, once per errand each,
 *    and only those still ahead when the run began: a 6-minute delivery never
 *    gets a "10 minutes" reminder after already being told 6).
 * 3. **Almost there** (within 500 m; the existing proximity alert, which now
 *    also fires from the live position rather than only from breadcrumbs).
 *
 * All four go to the "delivery-alerts" channel at high priority, with one tag
 * per errand, so on Android each replaces the last in the tray: one alert that
 * updates, not a stack of four. They arrive with the app closed or swiped from
 * recents; Android shows them itself (lib/pushNotifications.ts).
 *
 * Reminder state is in memory. After a restart a reminder may repeat once;
 * "almost there" never does, since it is guarded by proximityAlertSentAt.
 */

export const REMINDER_MINUTES = [10, 5] as const;

/** Within this, "almost there". Matches the proximity alert's threshold. */
export const ARRIVING_KM = 0.5;

const CHANNEL = "delivery-alerts";

interface RunState {
  /** Minutes to the customer when the run began, if they could be worked out. */
  initialMinutes: number | null;
  /** Reminder thresholds already sent (or skipped as already passed). */
  sent: Set<number>;
  at: number;
}

const runs = new Map<string, RunState>();
// Errands whose "almost there" is done in this process, to skip the database
// guard on every fix after it.
const arrived = new Set<string>();

export function tagFor(errandId: string): string {
  return `delivery-${errandId}`;
}

/**
 * The reminder threshold due now, if any: the smallest threshold the ETA has
 * reached that has not been sent, provided it was still ahead when the run
 * began. Marks every threshold at or above the ETA as done, so a rider who is
 * suddenly 4 minutes away gets one "5 minutes" reminder, not two.
 */
export function reminderDue(minutesLeft: number, state: Pick<RunState, "initialMinutes" | "sent">): number | null {
  let due: number | null = null;
  for (const threshold of REMINDER_MINUTES) {
    if (minutesLeft > threshold || state.sent.has(threshold)) continue;
    state.sent.add(threshold);
    // The run began already inside this threshold: the "on the way" push said so.
    if (state.initialMinutes != null && state.initialMinutes <= threshold + 1) continue;
    due = due === null ? threshold : Math.min(due, threshold);
  }
  return due;
}

function minutesFrom(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

async function deliveryParties(errandId: string) {
  const errand = await errandRepository.findById(errandId);
  if (!errand) return null;
  const customer = await customerRepository.findById(errand.customerId);
  if (!customer) return null;
  return { errand, customer };
}

/** Road minutes from the rider's current position to the customer, if known. */
async function minutesToCustomer(riderId: number, destination: { latitude: number; longitude: number }) {
  const position = riderPositionStore.getFresh(riderId, 2 * 60 * 1000);
  if (!position) return null;
  // The engine the rider's own map is following, so the number matches theirs.
  const engine = (riderChoiceFor(riderId)?.chosen as "osrm" | "google" | undefined) ?? "osrm";
  const route =
    (await resilient.routeWith(engine, [position.point, destination])) ??
    (engine !== "osrm" ? await resilient.routeWith("osrm", [position.point, destination]) : null);
  return route && !route.degraded ? minutesFrom(route.durationSeconds) : null;
}

/** 1. The rider has bought everything and is heading to the customer. */
export async function notifyOnTheWay(errandId: string): Promise<void> {
  const parties = await deliveryParties(errandId);
  if (!parties) return;
  const { errand, customer } = parties;
  if (errand.status !== "IN_TRANSIT" || !errand.riderId) return;
  if (errand.deliveryLatitude == null || errand.deliveryLongitude == null) return;

  const minutes = await minutesToCustomer(errand.riderId, {
    latitude: errand.deliveryLatitude,
    longitude: errand.deliveryLongitude,
  });
  runs.set(errandId, { initialMinutes: minutes, sent: new Set(), at: Date.now() });

  const riderName = errand.rider?.firstName?.trim() || "Your rider";
  const title = "Your order is on the way";
  const body =
    minutes != null
      ? `${riderName} bought everything and is heading to you. About ${minutes} min away.`
      : `${riderName} bought everything and is heading to you.`;

  const record = await notificationRepository.create({
    customerId: customer.id,
    type: "RIDER_ON_THE_WAY",
    title,
    body,
  });
  void sendPushNotification(customer.expoPushToken, {
    title,
    body,
    channelId: CHANNEL,
    tag: tagFor(errandId),
    urgent: true,
    data: { errandId, type: "RIDER_ON_THE_WAY" },
  });
  eventPublisher.emitToCustomer(customer.id, "notification:new", {
    id: record.id,
    type: "RIDER_ON_THE_WAY",
    title,
    body,
    errandId,
  });
}

/**
 * 2. The live ETA (etaService, about once a minute per errand) crossed a
 * reminder threshold. Delivery run only: no stops left, items bought.
 */
export async function onDeliveryEta(
  errand: { id: string; status: string; itemsPurchasedAt: Date | null },
  travelSeconds: number,
  remainingStopCount: number
): Promise<void> {
  if (errand.status !== "IN_TRANSIT" || !errand.itemsPurchasedAt || remainingStopCount > 0) return;

  let state = runs.get(errand.id);
  if (!state) {
    // The run began before a restart; nothing is known of what was sent.
    state = { initialMinutes: null, sent: new Set(), at: Date.now() };
    runs.set(errand.id, state);
  }
  const minutes = minutesFrom(travelSeconds);
  const threshold = reminderDue(minutes, state);
  if (threshold === null) return;

  const parties = await deliveryParties(errand.id);
  if (!parties) return;
  const title = "Your rider is getting close";
  const body = `About ${minutes} min away. Please get ready to receive your order.`;
  void sendPushNotification(parties.customer.expoPushToken, {
    title,
    body,
    channelId: CHANNEL,
    tag: tagFor(errand.id),
    urgent: true,
    data: { errandId: errand.id, type: "RIDER_ETA_REMINDER" },
  });
  eventPublisher.emitToCustomer(parties.customer.id, "notification:new", {
    type: "RIDER_ETA_REMINDER",
    title,
    body,
    errandId: errand.id,
  });
}

/**
 * 3. A live position for a rider on this errand. Cheap until the rider is
 * within ARRIVING_KM of the customer on the delivery run; then the proximity
 * alert, guarded in the database so it goes once however many paths see it.
 */
export async function onRiderPosition(
  errand: {
    id: string;
    status?: string | null;
    itemsPurchasedAt?: Date | null;
    deliveryLatitude?: number | null;
    deliveryLongitude?: number | null;
  },
  point: { latitude: number; longitude: number }
): Promise<void> {
  if (arrived.has(errand.id)) return;
  if (errand.status !== "IN_TRANSIT" || !errand.itemsPurchasedAt) return;
  if (errand.deliveryLatitude == null || errand.deliveryLongitude == null) return;

  const km = haversineDistanceKm(point, {
    latitude: errand.deliveryLatitude,
    longitude: errand.deliveryLongitude,
  });
  if (km > ARRIVING_KM) return;

  arrived.add(errand.id);
  const won = await errandRepository.markProximityAlertSent(errand.id);
  if (won.count === 0) return;

  const parties = await deliveryParties(errand.id);
  if (!parties) return;
  const storeSummary = (parties.errand.pinpoints ?? [])
    .map((pin: { storeName?: string | null }) => pin.storeName)
    .filter(Boolean)
    .join(" & ");
  const record = await notificationService.notifyRiderNearby(
    { id: parties.customer.id, expoPushToken: parties.customer.expoPushToken },
    errand.id,
    storeSummary
  );
  eventPublisher.emitToErrand(errand.id, "errand:rider_nearby", {
    errandId: errand.id,
    distanceKm: km,
    notificationId: record.id,
  });
  eventPublisher.emitToCustomer(parties.customer.id, "notification:new", {
    id: record.id,
    type: "RIDER_NEARBY",
    title: record.title,
    body: record.body,
  });
}

/** Fire-and-forget wrapper: reminders must never fail what triggered them. */
export function inBackground(task: Promise<void>, what: string): void {
  void task.catch((error) => logger.warn(`[deliveryReminder] ${what} failed:`, error));
}

/** Test seam. */
export function __resetDeliveryReminders(): void {
  runs.clear();
  arrived.clear();
}
