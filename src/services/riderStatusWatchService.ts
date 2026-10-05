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
import { notificationRepository } from "../repositories/notificationRepository.js";
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
 * A rider whose signal flaps must not fill every dispatcher's bell. One
 * persisted notification per rider per this window; the live alert still fires.
 */
const NOTIFICATION_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Cooldown for live socket toast alerts (rider:connectivity_alert).
 * Prevents rapid-fire toast spam when a phone experiences intermittent cell jitter.
 */
const LIVE_ALERT_COOLDOWN_MS = 60 * 1000;

interface Seen {
  status: RiderStatus;
  reason: RiderStatusReason;
  /** When the current signal loss began, for reminders. */
  lostAt: number | null;
  remindersSent: number;
}

const seen = new Map<number, Seen>();
const lastNotifiedAt = new Map<number, number>();
const lastLiveAlertAt = new Map<number, number>();
let seeded = false;

async function notifyDispatchers(riderId: number, riderName: string): Promise<void> {
  const last = lastNotifiedAt.get(riderId) ?? 0;
  if (Date.now() - last < NOTIFICATION_COOLDOWN_MS) return;
  lastNotifiedAt.set(riderId, Date.now());

  const dispatchers = await prisma.user.findMany({
    where: { role: "DISPATCHER", status: "Active" },
    select: { id: true },
  });
  await Promise.all(
    dispatchers.map((d) =>
      notificationRepository.create({
        userId: d.id,
        type: "RIDER_SIGNAL_LOST",
        title: `${riderName} lost signal`,
        body: `${riderName} is on duty but their phone has stopped reporting. They cannot be assigned until it reconnects. Consider calling them.`,
      })
    )
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

      // Only a rider who was reachable and dropped out is news. One moving
      // between two offline reasons, or first seen already lost, is not.
      if (lost && previous?.status === "AVAILABLE_ONLINE") {
        const lastAlert = lastLiveAlertAt.get(rider.id) ?? 0;
        if (now - lastAlert >= LIVE_ALERT_COOLDOWN_MS) {
          lastLiveAlertAt.set(rider.id, now);
          eventPublisher.emitToRole("DISPATCHER", "rider:connectivity_alert", { ...payload, reminder: false });
        }
        void notifyDispatchers(rider.id, name).catch((error) =>
          logger.error(`Could not notify dispatchers about rider ${rider.id}:`, error)
        );
      }
    } else if (lost && current.lostAt !== null) {
      const due = REMINDER_AFTER_MS[current.remindersSent];
      if (due !== undefined && now - current.lostAt >= due) {
        current.remindersSent += 1;
        eventPublisher.emitToRole("DISPATCHER", "rider:connectivity_alert", { ...payload, reminder: true });
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
  seeded = false;
}
