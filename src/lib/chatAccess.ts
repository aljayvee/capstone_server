import { getDatabaseWithUrl } from "firebase-admin/database";
import { firebaseUidFor, getFirebaseAdminApp } from "./firebaseAdmin.js";
import { FIREBASE_DATABASE_URL } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Who may open one errand's customer chat, `chats/<errandId>` in the Realtime
 * Database: the errand's customer and the dispatcher who claimed it. Owners
 * read every chat by role, so they are not listed.
 *
 * `firebase/database.rules.json` reads `chat_access/<errandId>`; only this file
 * writes it (the Admin SDK is not subject to the rules, and clients may not
 * touch the node). Until 2026-10-07 the rules let any signed-in account open
 * any chat whose errand id it knew, and the server broadcast every errand's id
 * to every connected phone, so customers were alerted to each other's chats.
 *
 * Failures are logged, never thrown: an order must not fail because Firebase
 * did. A chat whose entry is missing stays shut until the entry is written
 * (scripts/backfillChatAccess.ts rewrites every errand's entry).
 */

export interface ChatAccessEntry {
  customer: string;
  dispatcher: string | null;
}

function accessRef(errandId: string) {
  const app = getFirebaseAdminApp();
  if (!app) return null;
  return getDatabaseWithUrl(FIREBASE_DATABASE_URL, app).ref(`chat_access/${errandId}`);
}

async function write(errandId: string, what: string, apply: (ref: NonNullable<ReturnType<typeof accessRef>>) => Promise<void>) {
  try {
    const ref = accessRef(errandId);
    if (!ref) {
      logger.warn(`chat_access not written for ${errandId} (${what}): Firebase Admin is not configured.`);
      return false;
    }
    await apply(ref);
    return true;
  } catch (err) {
    logger.warn(`chat_access not written for ${errandId} (${what}):`, err);
    return false;
  }
}

/** A new errand: its customer may open its chat; no dispatcher yet. */
export function grantCustomerChat(errandId: string, customerId: number): Promise<boolean> {
  return write(errandId, "customer", (ref) =>
    ref.update({ customer: firebaseUidFor("CUSTOMER", customerId), dispatcher: null })
  );
}

/** A dispatcher claimed the errand (an id), or returned it to the queue (null). */
export function setChatDispatcher(errandId: string, dispatcherId: number | null): Promise<boolean> {
  return write(errandId, dispatcherId === null ? "release" : "claim", (ref) =>
    ref.update({ dispatcher: dispatcherId === null ? null : firebaseUidFor("DISPATCHER", dispatcherId) })
  );
}

/** Every entry at once, for the backfill: { errandId: entry }. */
export async function writeChatAccessBatch(entries: Record<string, ChatAccessEntry>): Promise<void> {
  const app = getFirebaseAdminApp();
  if (!app) throw new Error("Firebase Admin is not configured.");
  await getDatabaseWithUrl(FIREBASE_DATABASE_URL, app).ref("chat_access").update(entries);
}
