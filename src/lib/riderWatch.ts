import { getDatabaseWithUrl } from "firebase-admin/database";
import { firebaseUidFor, getFirebaseAdminApp } from "./firebaseAdmin.js";
import { FIREBASE_DATABASE_URL } from "../config/env.js";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

/**
 * Which customers may read a rider's live position, `riders/<riderId>` in the
 * Realtime Database: those whose errand the rider is working right now.
 *
 * The rules (firebase/database.rules.json) read `rider_watchers/<riderId>/
 * <customerUid>`, and only the server writes it. Until 2026-10-07 any signed-in
 * account could read any rider's position, so a customer could follow a rider
 * who had nothing to do with them.
 *
 * The node is rebuilt whole from MariaDB (reconcileRiderWatchers): soon after
 * every errand change and once a minute, so an errand finished by any path, or
 * a rider swapped out, stops being watchable without each path remembering to
 * say so. A new assignment is granted at once as well (grantRiderWatch),
 * before its event goes out, so the customer's map never asks before it may.
 */

/** Errand statuses during which a customer follows their rider. Shared with riderLocationBroadcast. */
export const TRACKABLE_STATUSES = ["ASSIGNED", "IN_TRANSIT"] as const;

export interface WatchErrand {
  id: string;
  customerId: number | null;
  riderId: number | null;
  status: string | null;
}

/** { riderId: { customerUid: { errandId: true } } }: one leaf per errand, so a second errand keeps access alive. */
export type RiderWatchTree = Record<string, Record<string, Record<string, true>>>;

export function isWatchable(errand: Pick<WatchErrand, "riderId" | "customerId" | "status">): boolean {
  return (
    errand.riderId != null &&
    errand.customerId != null &&
    (TRACKABLE_STATUSES as readonly string[]).includes(String(errand.status ?? "").toUpperCase())
  );
}

export function watchTree(errands: WatchErrand[]): RiderWatchTree {
  const tree: RiderWatchTree = {};
  for (const errand of errands) {
    if (!isWatchable(errand)) continue;
    const rider = String(errand.riderId);
    const customer = firebaseUidFor("CUSTOMER", errand.customerId as number);
    ((tree[rider] ??= {})[customer] ??= {})[errand.id] = true;
  }
  return tree;
}

function database() {
  const app = getFirebaseAdminApp();
  return app ? getDatabaseWithUrl(FIREBASE_DATABASE_URL, app) : null;
}

/** Lets this errand's customer watch its rider now. Never throws. */
export async function grantRiderWatch(errand: WatchErrand): Promise<boolean> {
  if (!isWatchable(errand)) return false;
  try {
    const db = database();
    if (!db) return false;
    await db
      .ref(`rider_watchers/${errand.riderId}/${firebaseUidFor("CUSTOMER", errand.customerId as number)}/${errand.id}`)
      .set(true);
    return true;
  } catch (err) {
    logger.warn(`rider_watchers grant failed for errand ${errand.id}:`, err);
    return false;
  }
}

/** Rewrites the whole node from the errands being worked now. Returns how many grants it holds. */
export async function reconcileRiderWatchers(): Promise<number> {
  const db = database();
  if (!db) return 0;
  const errands = await prisma.errand.findMany({
    where: { riderId: { not: null }, status: { in: [...TRACKABLE_STATUSES] } },
    select: { id: true, customerId: true, riderId: true, status: true },
  });
  await db.ref("rider_watchers").set(watchTree(errands));
  return errands.length;
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** A reconcile shortly after a burst of errand changes, once. */
export function scheduleRiderWatchReconcile(delayMs = 2000): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    reconcileRiderWatchers().catch((err) => logger.warn("rider_watchers reconcile failed:", err));
  }, delayMs);
  pending.unref?.();
}
