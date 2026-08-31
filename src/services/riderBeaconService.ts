import { riderPresenceRepository } from "../repositories/riderPresenceRepository.js";
import { riderLoginSessionRepository } from "../repositories/riderLoginSessionRepository.js";
import * as riderPositionStore from "../lib/riderPositionStore.js";
import * as riderPresenceStore from "../lib/riderPresenceStore.js";
import {
  availabilityOf,
  type AvailabilityResult,
  type PresenceSnapshot,
} from "../lib/riderAvailability.js";
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
): Promise<AvailabilityResult & { riderId: number }> {
  const now = new Date();
  const recordedAt = input.recordedAt ?? now;

  await riderPresenceRepository.upsert(riderId, {
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    accuracyMeters: input.accuracyMeters ?? null,
    headingDeg: input.headingDeg ?? null,
    onDuty: input.onDuty,
    backgroundLocation: input.backgroundLocation,
    notifications: input.notifications,
    exactAlarms: input.exactAlarms,
    beaconIntervalMs: input.beaconIntervalMs ?? null,
    connectivity: input.connectivity ?? null,
    recordedAt,
    lastBeaconAt: now,
    // Cleared by any ordinary beacon: a rider who shut down and came back is
    // present again, and a stale shutdown marker would pin them to OFFLINE.
    shutdownAt: input.shuttingDown ? now : null,
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
  }

  const session = await riderLoginSessionRepository.findOpenForRider(riderId);

  return {
    riderId,
    ...availabilityOf({
      hasSession: Boolean(session),
      onDuty: input.onDuty,
      backgroundLocation: input.backgroundLocation,
      notifications: input.notifications,
      exactAlarms: input.exactAlarms,
    beaconIntervalMs: input.beaconIntervalMs ?? null,
      lastBeaconAt: now.getTime(),
      shutdownAt: input.shuttingDown ? now.getTime() : null,
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
      });
      continue;
    }

    const snapshot: PresenceSnapshot = {
      hasSession: withSession.has(riderId),
      onDuty: row.onDuty,
      backgroundLocation: row.backgroundLocation,
      notifications: row.notifications,
      exactAlarms: row.exactAlarms,
      beaconIntervalMs: row.beaconIntervalMs ?? null,
      lastBeaconAt: row.lastBeaconAt?.getTime() ?? null,
      shutdownAt: row.shutdownAt?.getTime() ?? null,
    };
    result.set(riderId, availabilityOf(snapshot, now));
  }
  return result;
}
