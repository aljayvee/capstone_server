import { getDatabaseWithUrl, type DataSnapshot, type Reference } from "firebase-admin/database";
import type { ErrandStatus } from "@prisma/client";
import { getFirebaseAdminApp } from "../lib/firebaseAdmin.js";
import { FIREBASE_DATABASE_URL } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { deliverToStaff } from "./notificationService.js";
import { riderRef } from "./notificationCatalog.js";

/**
 * Puts a rider's message to dispatch in the dispatcher's bell.
 *
 * Rider chat never touches the API: the rider app writes straight to the
 * Realtime Database (RiderMobileApp src/firebase/dispatcherChat.ts), so the
 * server listens for what it writes. Two places, by `config/riderChatMode`:
 * - "threads": `dispatcher_inbox/staff_<id>/<riderId>`, one summary row per
 *   conversation. That dispatcher gets the row.
 * - "shared": `rider_chats/<riderId>/meta`, read by every dispatcher. Every
 *   active dispatcher gets the row. Listened per rider, because `rider_chats`
 *   also holds every message and a listener on the whole node would download
 *   them all on each change.
 *
 * Only `lastSender: "rider"` counts, and only a write after this process
 * started: a restart must not replay old conversations into the bell. One
 * server process is assumed; a second would write every row twice.
 */

// Same set as errandRepository.countActiveByRider.
const ACTIVE_EXCLUDED: ErrandStatus[] = ["DELIVERED", "COMPLETED", "CANCELLED"];
const RIDER_REFRESH_MS = 10 * 60 * 1000;

export interface RiderChatMeta {
  lastMessage?: unknown;
  lastSender?: unknown;
  senderName?: unknown;
  riderName?: unknown;
  updatedAt?: unknown;
}

/** The last write handled per conversation, so a repeated snapshot is told once. */
const handled = new Map<string, number>();
let startedAt = Date.now();

const snippet = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}...` : text);

/**
 * One rider message, from either place. `staffUid` is set for a thread, null
 * for the shared conversation. Exported for tests; returns the recipients.
 */
export async function handleRiderMessage(
  riderId: string,
  staffUid: string | null,
  meta: RiderChatMeta | null | undefined
): Promise<number[]> {
  if (!meta || meta.lastSender !== "rider") return [];
  const updatedAt = Number(meta.updatedAt) || 0;
  if (updatedAt <= startedAt) return [];
  const rider = Number(riderId);
  if (!Number.isInteger(rider) || rider <= 0) return [];

  const key = `${staffUid ?? "shared"}:${riderId}`;
  if ((handled.get(key) ?? 0) >= updatedAt) return [];
  handled.set(key, updatedAt);

  let recipients: number[];
  if (staffUid) {
    const staffId = Number(staffUid.replace(/^staff_/, ""));
    if (!Number.isInteger(staffId) || staffId <= 0) return [];
    recipients = [staffId];
  } else {
    recipients = (
      await prisma.user.findMany({ where: { role: "DISPATCHER", status: "Active" }, select: { id: true } })
    ).map((u) => u.id);
  }

  // A rider with an errand on hand is usually asking about it, at a shop, now.
  const onHand = await prisma.errand.count({ where: { riderId: rider, status: { notIn: ACTIVE_EXCLUDED } } });
  const name = String(meta.senderName || meta.riderName || "").trim() || "A rider";
  const text = String(meta.lastMessage || "").trim() || "New message";

  const rows = await deliverToStaff(
    recipients,
    "RIDER_CHAT_MESSAGE",
    { title: `Message from ${name}`, body: snippet(text) },
    riderRef(rider),
    onHand > 0 ? "HIGH" : "NORMAL"
  );
  return rows.map((row) => row.userId).filter((id): id is number => id !== null);
}

function report(error: unknown) {
  logger.error("Rider chat notification failed:", error);
}

/** Starts listening. A no-op without a Firebase service account. Returns a stop function. */
export function startRiderChatWatch(): () => void {
  const app = getFirebaseAdminApp();
  if (!app) {
    logger.warn("Rider chat watch not started: Firebase Admin is not configured.");
    return () => undefined;
  }
  const db = getDatabaseWithUrl(FIREBASE_DATABASE_URL, app);
  startedAt = Date.now();
  const stops: Array<() => void> = [];

  // Threads: each child is one dispatcher's inbox, { <riderId>: meta }.
  const inbox = db.ref("dispatcher_inbox");
  const onInbox = (snapshot: DataSnapshot) => {
    const staffUid = snapshot.key;
    if (!staffUid?.startsWith("staff_")) return;
    snapshot.forEach((row) => {
      if (row.key) void handleRiderMessage(row.key, staffUid, row.val()).catch(report);
      return false;
    });
  };
  inbox.on("child_added", onInbox, report);
  inbox.on("child_changed", onInbox, report);
  stops.push(() => {
    inbox.off("child_added", onInbox);
    inbox.off("child_changed", onInbox);
  });

  // Shared: one listener on each rider's summary row.
  const watched = new Map<number, Reference>();
  const onShared = (snapshot: DataSnapshot) => {
    const riderId = snapshot.ref.parent?.key;
    if (riderId) void handleRiderMessage(riderId, null, snapshot.val()).catch(report);
  };
  const refreshRiders = async () => {
    const riders = await prisma.user.findMany({ where: { role: "RIDER" }, select: { id: true } });
    for (const { id } of riders) {
      if (watched.has(id)) continue;
      const ref = db.ref(`rider_chats/${id}/meta`);
      ref.on("value", onShared, report);
      watched.set(id, ref);
    }
  };
  void refreshRiders().catch(report);
  const timer = setInterval(() => void refreshRiders().catch(report), RIDER_REFRESH_MS);
  timer.unref?.();
  stops.push(() => {
    clearInterval(timer);
    for (const ref of watched.values()) ref.off("value", onShared);
    watched.clear();
  });

  logger.info("Rider chat watch started.");
  return () => stops.forEach((stop) => stop());
}

/** For tests: forget what was handled and treat `at` as the start. */
export function resetRiderChatWatch(at = 0): void {
  handled.clear();
  startedAt = at;
}
