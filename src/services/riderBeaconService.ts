import { riderPresenceRepository } from "../repositories/riderPresenceRepository.js";
import { riderLoginSessionRepository } from "../repositories/riderLoginSessionRepository.js";
import * as riderPositionStore from "../lib/riderPositionStore.js";
import * as riderPresenceStore from "../lib/riderPresenceStore.js";
import { broadcastRiderLocation } from "../lib/riderLocationBroadcast.js";
import { liveLinkOf } from "../lib/riderLiveLink.js";
import {
  availabilityOf,
  mostRecentManilaMidnight,
  OFFLINE_AFTER_MS,
  type AvailabilityResult,
  type PresenceSnapshot,
} from "../lib/riderAvailability.js";
import { logger } from "../lib/logger.js";
import type { RiderBeaconInput } from "../validators/riderBeaconValidators.js";

/**
 * Records one presence beacon and answers with what the rider now counts as.
 *
 * Writes through to BOTH stores on purpose. `riderPositionStore` is the
 * in-process cache dispatch and the ETA engine already read, so writing it here
 * is what finally makes an idle rider rankable. The `rider_presence` row is the
 * durable copy, so a server restart no longer erases the entire fleet's
 * availability and force everyone to start an errand before they can be given one.
 */
export async function recordBeacon(
  riderId: number,
  input: RiderBeaconInput
): Promise<AvailabilityResult & { riderId: number; forcedOffline: "midnight_reset" | null }> {
  const now = new Date();
  const recordedAt = input.recordedAt ?? now;

  // Every shift ends at 12:00 AM Manila time. A device still reporting a shift
  // that began before then (the app was closed and missed the moment, or its
  // clock check never ran) is recorded as off duty, stamped at midnight so the
  // screens say why, and told to stop in the reply below. Builds that do not
  // send dutySince cannot be held to this and keep the old behaviour.
  const midnight = mostRecentManilaMidnight(now.getTime());
  const staleShift = input.onDuty && input.dutySince != null && input.dutySince < midnight;
  const onDuty = input.onDuty && !staleShift;
  const shutdownAt = staleShift ? new Date(midnight) : input.shuttingDown ? now : null;

  await riderPresenceRepository.upsert(riderId, {
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    accuracyMeters: input.accuracyMeters ?? null,
    headingDeg: input.headingDeg ?? null,
    onDuty,
    backgroundLocation: input.backgroundLocation,
    notifications: input.notifications,
    exactAlarms: input.exactAlarms,
    beaconIntervalMs: input.beaconIntervalMs ?? null,
    connectivity: input.connectivity ?? null,
    recordedAt,
    lastBeaconAt: now,
    // Cleared by any ordinary beacon: a rider who shut down and came back is
    // present again, and a stale shutdown marker would pin them to OFFLINE.
    shutdownAt,
  });

  // Only a real fix updates the position cache. A beacon from a rider who has
  // revoked location still records presence, but must not overwrite the last
  // known coordinate with nothing — `record()` already ignores out-of-order
  // arrivals, so a stale flush cannot clobber a fresher fix either.
  if (input.latitude != null && input.longitude != null) {
    riderPositionStore.record(riderId, {
      point: { latitude: input.latitude, longitude: input.longitude },
      recordedAt: recordedAt.getTime(),
      accuracyMeters: input.accuracyMeters ?? null,
      headingDeg: input.headingDeg ?? null,
    });
    // The beacon is also a live fix. For a rider app that predates the socket
    // stream, this is the only socket-borne position its viewers will get.
    broadcastRiderLocation(
      riderId,
      {
        latitude: input.latitude,
        longitude: input.longitude,
        headingDeg: input.headingDeg ?? null,
        accuracyMeters: input.accuracyMeters ?? null,
        recordedAt: recordedAt.getTime(),
      },
      "beacon"
    );
  }

  let session = await riderLoginSessionRepository.findOpenForRider(riderId);
  if (!session && onDuty && !input.shuttingDown) {
    session = await riderLoginSessionRepository.open(riderId);
  }

  return {
    riderId,
    forcedOffline: staleShift ? "midnight_reset" : null,
    ...availabilityOf({
      hasSession: Boolean(session),
      onDuty,
      backgroundLocation: input.backgroundLocation,
      notifications: input.notifications,
      exactAlarms: input.exactAlarms,
      beaconIntervalMs: input.beaconIntervalMs ?? null,
      lastBeaconAt: now.getTime(),
      shutdownAt: shutdownAt?.getTime() ?? null,
    }),
  };
}

/**
 * The availability of many riders at once, for dispatch.
 *
 * Reads the durable rows rather than the in-process cache so the answer survives
 * a restart, and so a second API instance would at least be reading the same
 * table rather than its own private memory (see the scaling note in the design).
 */
export async function availabilityForRiders(
  riderIds: number[],
  now: number = Date.now()
): Promise<Map<number, AvailabilityResult>> {
  if (riderIds.length === 0) return new Map();

  const [rows, openSessions] = await Promise.all([
    riderPresenceRepository.findMany(riderIds),
    riderLoginSessionRepository.findAllOpen(),
  ]);

  const withSession = new Set(openSessions.map((s) => s.riderId));
  const byRider = new Map(rows.map((r) => [r.riderId, r]));

  const result = new Map<number, AvailabilityResult>();
  for (const riderId of riderIds) {
    const row = byRider.get(riderId);

    // TRANSITIONAL: a rider whose app predates the beacon has no presence row at
    // all, and would otherwise be undispatchable the moment this ships — the
    // whole fleet excluded until every handset updates. Until then they fall
    // back to socket presence, which is the behaviour they have today.
    //
    // This bridge carries the Doze bug it exists to fix, so it is deliberately
    // narrow: it applies ONLY when no beacon has ever been seen for that rider.
    // One beacon and they are on the new path permanently. Remove this block once
    // the rollout is complete — it has no other reason to exist.
    if (!row) {
      const online = riderPresenceStore.isOnline(riderId);
      result.set(riderId, {
        state: online ? "AVAILABLE" : "OFFLINE",
        dispatchable: online,
        impediments: [],
        beaconAgeMs: null,
        presumed: !online,
        riderStatus: online ? "AVAILABLE_ONLINE" : "OFFLINE",
        riderStatusReason: online ? "online" : "never_connected",
        lastBeaconAt: null,
      });
      continue;
    }

    const isBeaconFreshAndOnDuty = Boolean(
      row.onDuty &&
      row.shutdownAt === null &&
      row.lastBeaconAt &&
      now - row.lastBeaconAt.getTime() <= OFFLINE_AFTER_MS
    );

    const hasSession = withSession.has(riderId) || isBeaconFreshAndOnDuty;

    if (!withSession.has(riderId) && isBeaconFreshAndOnDuty) {
      void riderLoginSessionRepository.open(riderId).catch((err) => {
        logger.error(`Failed to auto-open missing rider session for rider ${riderId}:`, err);
      });
      withSession.add(riderId);
    }

    // The one-second WebSocket heartbeat (lib/riderLiveLink.ts), when the app
    // is open and sending it. Flowing, it counts as hearing from the rider just
    // now. Stopped, it overrides a beacon that has not yet gone stale: that is
    // the whole point of it, since the beacon takes 25 to 75 s to notice.
    const live = liveLinkOf(riderId);
    const beaconAt = row.lastBeaconAt?.getTime() ?? null;

    const snapshot: PresenceSnapshot = {
      hasSession,
      onDuty: row.onDuty,
      backgroundLocation: row.backgroundLocation,
      notifications: row.notifications,
      exactAlarms: row.exactAlarms,
      beaconIntervalMs: row.beaconIntervalMs ?? null,
      lastBeaconAt: live && !live.lost ? Math.max(beaconAt ?? 0, live.lastHeartbeatAt) : beaconAt,
      shutdownAt: row.shutdownAt?.getTime() ?? null,
    };
    let availability = availabilityOf(snapshot, now);
    // A beacon received after the last heartbeat proves the phone still has
    // connectivity (including when Android suspended the foreground socket
    // before its pause frame arrived). Its own expiry decides availability.
    if (live?.lost && (beaconAt === null || beaconAt <= live.lastHeartbeatAt) && availability.riderStatus === "AVAILABLE_ONLINE") {
      availability = {
        ...availability,
        state: "SIGNAL_LOST",
        dispatchable: false,
        beaconAgeMs: Math.max(0, now - live.lastHeartbeatAt),
        riderStatus: "AVAILABLE_SIGNAL_LOST",
        riderStatusReason: "signal_lost",
        lastBeaconAt: live.lastHeartbeatAt,
      };
    }
    result.set(riderId, availability);
  }
  return result;
}
