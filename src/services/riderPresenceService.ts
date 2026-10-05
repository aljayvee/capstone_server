import { riderLoginSessionRepository } from "../repositories/riderLoginSessionRepository.js";
import { riderStatusLogRepository } from "../repositories/riderStatusLogRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import * as riderPresenceStore from "../lib/riderPresenceStore.js";
import { riderPresenceRepository } from "../repositories/riderPresenceRepository.js";
import { logger } from "../lib/logger.js";

// How long a rider can stay absent from the presence store before their still-open
// login session is treated as abandoned (app killed without an explicit logout) and
// closed by the sweep below. ~3 snapshot cycles, so a couple of missed ticks from a
// flaky connection don't prematurely close a session that's about to reconnect.
const ABANDONED_SESSION_GRACE_MS = 6 * 60 * 1000;

export function isRiderOnline(riderId: number): boolean {
  return riderPresenceStore.isOnline(riderId);
}

export async function openLoginSession(riderId: number) {
  const existing = await riderLoginSessionRepository.findOpenForRider(riderId);
  if (existing) return existing;
  return riderLoginSessionRepository.open(riderId);
}

export async function closeLoginSession(riderId: number) {
  // Presence is cleared even when there is no open session row to close: a rider
  // who signs out must stop being dispatchable immediately, and a beacon that
  // arrived seconds earlier would otherwise keep them AVAILABLE for the full
  // grace window.
  await riderPresenceRepository.clearForRider(riderId);

  const session = await riderLoginSessionRepository.findOpenForRider(riderId);
  if (!session) return;
  const logoutAt = new Date();
  const durationSeconds = Math.max(0, Math.round((logoutAt.getTime() - session.loginAt.getTime()) / 1000));
  await riderLoginSessionRepository.close(session.id, logoutAt, durationSeconds);
}

// Every 2 minutes: archive one ONLINE/OFFLINE row per rider, and close any
// login session left open by a rider who force-quit without logging out.
export async function recordStatusSnapshot() {
  const riders = await userRepository.findAllRiders();
  if (riders.length === 0) return;
  const presenceRows = await riderPresenceRepository.findMany(riders.map((r) => r.id));
  const presenceByRider = new Map(presenceRows.map((r) => [r.riderId, r]));
  const now = Date.now();

  const entries = riders.map((r) => {
    const p = presenceByRider.get(r.id);
    const hasFreshBeacon = Boolean(
      p &&
      p.onDuty &&
      p.shutdownAt === null &&
      p.lastBeaconAt &&
      now - p.lastBeaconAt.getTime() < ABANDONED_SESSION_GRACE_MS
    );
    const online = riderPresenceStore.isOnline(r.id) || hasFreshBeacon;
    return {
      riderId: r.id,
      status: (online ? "ONLINE" : "OFFLINE") as "ONLINE" | "OFFLINE",
    };
  });
  await riderStatusLogRepository.createMany(entries);
}

export async function sweepAbandonedLoginSessions() {
  const openSessions = await riderLoginSessionRepository.findAllOpen();
  if (openSessions.length === 0) return;
  const now = Date.now();

  const riderIds = openSessions.map((s) => s.riderId);
  const presenceRows = await riderPresenceRepository.findMany(riderIds);
  const presenceByRider = new Map(presenceRows.map((r) => [r.riderId, r]));

  for (const session of openSessions) {
    if (riderPresenceStore.isOnline(session.riderId)) {
      continue;
    }

    const presence = presenceByRider.get(session.riderId);

    // Active beacon check: if rider is on duty and sending beacons within grace window, do NOT close
    if (presence && presence.onDuty && presence.shutdownAt === null && presence.lastBeaconAt) {
      const beaconAgeMs = now - presence.lastBeaconAt.getTime();
      if (beaconAgeMs < ABANDONED_SESSION_GRACE_MS) {
        continue;
      }
    }

    const lastDisconnectedAt = riderPresenceStore.getLastDisconnectedAt(session.riderId);
    const lastBeaconAtTime = presence?.lastBeaconAt?.getTime();

    const lastActivityTimestamp = Math.max(
      lastDisconnectedAt ?? 0,
      lastBeaconAtTime ?? 0
    );

    const effectiveLogoutAtMs = lastActivityTimestamp > 0 ? lastActivityTimestamp : now;

    if (now - effectiveLogoutAtMs < ABANDONED_SESSION_GRACE_MS) {
      continue;
    }

    // Clamp effectiveLogoutAt so it is NEVER before session.loginAt
    const loginAtMs = session.loginAt.getTime();
    const safeLogoutAtMs = Math.max(loginAtMs, effectiveLogoutAtMs);
    const effectiveLogoutAt = new Date(safeLogoutAtMs);

    const durationSeconds = Math.max(
      0,
      Math.round((effectiveLogoutAt.getTime() - loginAtMs) / 1000)
    );

    try {
      await riderLoginSessionRepository.close(session.id, effectiveLogoutAt, durationSeconds);
    } catch (error) {
      logger.error(`Failed to close abandoned rider login session ${session.id}:`, error);
    }
  }
}
