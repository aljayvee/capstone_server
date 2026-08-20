import { riderLoginSessionRepository } from "../repositories/riderLoginSessionRepository.js";
import { riderStatusLogRepository } from "../repositories/riderStatusLogRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import * as riderPresenceStore from "../lib/riderPresenceStore.js";
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
  return riderLoginSessionRepository.open(riderId);
}

export async function closeLoginSession(riderId: number) {
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
  const entries = riders.map((r) => ({
    riderId: r.id,
    status: (riderPresenceStore.isOnline(r.id) ? "ONLINE" : "OFFLINE") as "ONLINE" | "OFFLINE",
  }));
  await riderStatusLogRepository.createMany(entries);
}

export async function sweepAbandonedLoginSessions() {
  const openSessions = await riderLoginSessionRepository.findAllOpen();
  const now = Date.now();

  for (const session of openSessions) {
    if (riderPresenceStore.isOnline(session.riderId)) {
      continue;
    }
    const lastDisconnectedAt = riderPresenceStore.getLastDisconnectedAt(session.riderId);
    // No recorded disconnect time (e.g. the server restarted since this rider
    // last connected) — nothing better to go on, so treat it as abandoned now.
    const effectiveLogoutAt = lastDisconnectedAt !== undefined ? new Date(lastDisconnectedAt) : new Date(now);
    if (now - effectiveLogoutAt.getTime() < ABANDONED_SESSION_GRACE_MS) {
      continue;
    }
    const durationSeconds = Math.max(
      0,
      Math.round((effectiveLogoutAt.getTime() - session.loginAt.getTime()) / 1000)
    );
    try {
      await riderLoginSessionRepository.close(session.id, effectiveLogoutAt, durationSeconds);
    } catch (error) {
      logger.error(`Failed to close abandoned rider login session ${session.id}:`, error);
    }
  }
}
