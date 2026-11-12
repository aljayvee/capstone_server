import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import {
  describeReason,
  mostRecentManilaMidnight,
  type RiderStatus,
  type RiderStatusReason,
} from "../lib/riderAvailability.js";
import { userRepository } from "../repositories/userRepository.js";
import { errandRepository } from "../repositories/errandRepository.js";
import { riderLoginSessionRepository } from "../repositories/riderLoginSessionRepository.js";
import { notifyStaff } from "./notificationService.js";
import { riderRef } from "./notificationCatalog.js";
import * as riderBeaconService from "./riderBeaconService.js";
import { emitToRiderCustomers } from "../lib/riderLocationBroadcast.js";

// Re-exported for callers that already import it from here.
export { describeReason };

/**
 * Two jobs around the three rider statuses (AVAILABLE_ONLINE,
 * AVAILABLE_SIGNAL_LOST, OFFLINE):
 *
 * 1. **Watching for changes.** A status is derived on read, from beacons, so
 *    nothing happens at the moment a rider's phone goes quiet. This polls the
 *    fleet and turns each change into a `rider:status_changed` event for the
 *    dispatcher and owner screens, and a rider losing signal into a
 *    `rider:connectivity_alert` plus a notification in each dispatcher's bell.
 * 2. **Ending every shift at 12:00 AM Manila time.** Riders on duty at
 *    midnight are set off duty and their login sessions closed, so the day
 *    starts from a clean board, and a phone that died mid-shift stops showing
 *    as signal lost forever.
 */

/** Reminders after the first alert, while the rider is still out of contact. */
const REMINDER_AFTER_MS = [5 * 60 * 1000, 15 * 60 * 1000];

/**
 * A rider whose signal flaps must not fill every dispatcher's bell or toasts.
 */
const NOTIFICATION_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Status/assignment safety updates immediately; interrupt dispatchers only
 * after a continuous loss, with the same cooldown for toasts and saved alerts.
 */
export const SIGNAL_LOSS_ALERT_GRACE_MS = 30 * 1000;

interface Seen {
  status: RiderStatus;
  reason: RiderStatusReason;
  /** When the current signal loss began, for reminders. */
  lostAt: number | null;
  remindersSent: number;
  /** A rider seen online dropped out; consume after the confirmation window. */
  notifyOnLoss: boolean;
}

const seen = new Map<number, Seen>();
const lastNotifiedAt = new Map<number, number>();
const lastLiveAlertAt = new Map<number, number>();
let seeded = false;

/**
 * Riders whose loss was written to the bell, and whether owners heard too, so
 * the "back online" row goes to exactly the people told about the loss.
 */
const lossNotified = new Map<number, { ownersToo: boolean }>();

/** Escalates once per loss: still dark after this long, with errands on hand. */
const ESCALATE_AFTER_MS = 15 * 60 * 1000;

async function notifyDispatchers(riderId: number, riderName: string, activeOrders: number, now: number): Promise<void> {
  const last = lastNotifiedAt.get(riderId);
  if (last !== undefined && now - last < NOTIFICATION_COOLDOWN_MS) return;
  lastNotifiedAt.set(riderId, now);

  // Owners hear about a lost rider only when errands are riding on them.
  const ownersToo = activeOrders > 0;
  lossNotified.set(riderId, { ownersToo });
  await notifyStaff(
    "RIDER_SIGNAL_LOST",
    {
      title: `${riderName} lost signal`,
      body: `${riderName} is on duty but their phone has stopped reporting. They cannot be assigned until it reconnects. Consider calling them.`,
    },
    { refKey: riderRef(riderId), includeOwners: ownersToo }
  );
}

async function escalateLostRider(riderId: number, riderName: string, activeOrders: number): Promise<void> {
  if (activeOrders <= 0) return;
  lossNotified.set(riderId, { ownersToo: true });
  await notifyStaff(
    "RIDER_SIGNAL_LOST_PERSISTING",
    {
      title: `${riderName} still has no signal after 15 min`,
      body: `${riderName} has ${activeOrders} errand${activeOrders === 1 ? "" : "s"} on hand and has not reported for 15 minutes. Call them or reassign.`,
    },
    { refKey: riderRef(riderId) }
  );
}

async function notifyRestored(riderId: number, riderName: string): Promise<void> {
  const told = lossNotified.get(riderId);
  if (!told) return;
  lossNotified.delete(riderId);
  await notifyStaff(
    "RIDER_SIGNAL_RESTORED",
    { title: `${riderName} is back online`, body: `${riderName}'s phone is reporting again.` },
    { refKey: riderRef(riderId), includeOwners: told.ownersToo }
  );
}

/**
 * One pass over the fleet. Exported for the job and for tests; the first call
 * after a restart only records what it sees, so a deploy does not raise an
 * alert for every rider already out of contact.
 */
export async function checkRiderStatuses(now: number = Date.now()): Promise<void> {
  const riders = await userRepository.findAllRiders();
  if (riders.length === 0) return;

  const [availability, activeCounts] = await Promise.all([
    riderBeaconService.availabilityForRiders(
      riders.map((r) => r.id),
      now
    ),
    errandRepository.countActiveByRider(),
  ]);
  const activeByRider = new Map<number, number>();
  for (const entry of activeCounts) {
    if (entry.riderId !== null) activeByRider.set(entry.riderId, entry._count._all);
  }

  for (const rider of riders) {
    const result = availability.get(rider.id);
    if (!result) continue;
    const name = `${rider.firstName} ${rider.lastName}`.trim() || `Rider ${rider.id}`;
    const previous = seen.get(rider.id);
    const lost = result.riderStatus === "AVAILABLE_SIGNAL_LOST";

    const current: Seen = {
      status: result.riderStatus,
      reason: result.riderStatusReason,
      lostAt: lost ? previous?.lostAt ?? now : null,
      remindersSent: lost ? previous?.remindersSent ?? 0 : 0,
      notifyOnLoss: lost && (previous?.status === "AVAILABLE_SIGNAL_LOST" ? previous.notifyOnLoss : previous?.status === "AVAILABLE_ONLINE"),
    };

    if (!seeded) {
      seen.set(rider.id, current);
      continue;
    }

    const payload = {
      riderId: rider.id,
      name,
      riderStatus: result.riderStatus,
      riderStatusReason: result.riderStatusReason,
      reasonText: describeReason(result.riderStatusReason),
      lastBeaconAt: result.lastBeaconAt,
      activeOrdersCount: activeByRider.get(rider.id) ?? 0,
      at: now,
    };

    if (!previous || previous.status !== current.status || previous.reason !== current.reason) {
      eventPublisher.emitToRole("DISPATCHER", "rider:status_changed", payload);
      eventPublisher.emitToRole("OWNER", "rider:status_changed", payload);
      // The customer tracking this rider hears the same change, minus the
      // operational detail they have no use for.
      void emitToRiderCustomers(rider.id, "rider:status_changed", {
        riderId: rider.id,
        riderStatus: result.riderStatus,
        reasonText: describeReason(result.riderStatusReason),
        at: now,
      });

      if (result.riderStatus === "AVAILABLE_ONLINE" && previous?.status === "AVAILABLE_SIGNAL_LOST") {
        void notifyRestored(rider.id, name).catch((error) =>
          logger.error(`Could not notify that rider ${rider.id} is back:`, error)
        );
      } else if (result.riderStatus === "OFFLINE") {
        // Went off duty instead of coming back: nothing to announce later.
        lossNotified.delete(rider.id);
      }
    }

    // Evaluate on every pass, not only a status transition. Brief losses clear
    // this pending alert on recovery and produce neither a loss nor a restore
    // notification. Riders already lost at startup are only seeded above.
    if (lost && current.lostAt !== null && current.notifyOnLoss && now - current.lostAt >= SIGNAL_LOSS_ALERT_GRACE_MS) {
      current.notifyOnLoss = false;
      const lastAlert = lastLiveAlertAt.get(rider.id);
      if (lastAlert === undefined || now - lastAlert >= NOTIFICATION_COOLDOWN_MS) {
        lastLiveAlertAt.set(rider.id, now);
        eventPublisher.emitToRole("DISPATCHER", "rider:connectivity_alert", { ...payload, reminder: false });
        void notifyDispatchers(rider.id, name, payload.activeOrdersCount, now).catch((error) =>
          logger.error(`Could not notify dispatchers about rider ${rider.id}:`, error)
        );
      }
    } else if (lost && current.lostAt !== null && lossNotified.has(rider.id)) {
      const due = REMINDER_AFTER_MS[current.remindersSent];
      if (due !== undefined && now - current.lostAt >= due) {
        current.remindersSent += 1;
        eventPublisher.emitToRole("DISPATCHER", "rider:connectivity_alert", { ...payload, reminder: true });
        // The 15-minute reminder is the one that becomes Critical, once.
        if (due >= ESCALATE_AFTER_MS && lossNotified.has(rider.id)) {
          void escalateLostRider(rider.id, name, payload.activeOrdersCount).catch((error) =>
            logger.error(`Could not escalate rider ${rider.id}:`, error)
          );
        }
      }
    }

    seen.set(rider.id, current);
  }

  seeded = true;
}

/**
 * Ends every shift at 12:00 AM. Riders on duty are set off duty with their
 * shutdown stamped at the midnight instant (which is how every screen can say
 * "shift ended at 12:00 AM" rather than a vaguer "offline"), and every open
 * login session is closed at midnight so shift reports split by day.
 *
 * Riders' app sign-ins are not touched: they stay logged in to the app and go
 * online again with one tap. Returns how many riders were taken off duty.
 */
export async function resetShiftsAtMidnight(now: number = Date.now()): Promise<number> {
  const midnight = new Date(mostRecentManilaMidnight(now));

  const onDuty = await prisma.riderPresence.findMany({
    where: { onDuty: true },
    select: { riderId: true },
  });
  if (onDuty.length > 0) {
    await prisma.riderPresence.updateMany({
      where: { riderId: { in: onDuty.map((r) => r.riderId) } },
      data: { onDuty: false, shutdownAt: midnight },
    });
  }

  const openSessions = await riderLoginSessionRepository.findAllOpen();
  for (const session of openSessions) {
    const logoutAt = new Date(Math.max(session.loginAt.getTime(), midnight.getTime()));
    const durationSeconds = Math.max(0, Math.round((logoutAt.getTime() - session.loginAt.getTime()) / 1000));
    try {
      await riderLoginSessionRepository.close(session.id, logoutAt, durationSeconds);
    } catch (error) {
      logger.error(`Midnight reset could not close rider session ${session.id}:`, error);
    }
  }

  for (const { riderId } of onDuty) {
    eventPublisher.emit("rider:presence_changed", { riderId, online: false });
  }
  logger.info(
    `Midnight shift reset: ${onDuty.length} rider(s) taken off duty, ${openSessions.length} session(s) closed.`
  );

  // Picked up by the next watcher pass as ordinary status changes.
  return onDuty.length;
}

/** For tests. */
export function resetWatchState(): void {
  seen.clear();
  lastNotifiedAt.clear();
  lastLiveAlertAt.clear();
  lossNotified.clear();
  seeded = false;
}
