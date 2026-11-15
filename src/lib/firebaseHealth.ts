/**
 * firebaseHealth.ts
 *
 * Two checks on the Realtime Database, which carries live rider tracking and
 * both chat channels without going through this API (so every API check can
 * be green while dispatch is blind):
 *
 * 1. Heartbeat: write `_server_health/heartbeat` and read it back. Catches
 *    Firebase being down, the credentials being revoked, or quota/billing
 *    stopping writes. The root rule denies clients, so nobody else sees it.
 *
 * 2. Rules drift: compare the live ruleset with the reviewed copy in
 *    firebase/database.rules.json. The Admin SDK ignores rules, so the
 *    heartbeat cannot see the failure that actually happened here: a Console
 *    edit to the rules stopped tracking and chat for every client while the
 *    server stayed healthy (see firebase/README.md).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { FIREBASE_DATABASE_URL } from "../config/env.js";
import { getFirebaseAdminApp } from "./firebaseAdmin.js";

export const FIREBASE_TIMEOUT_MS = 5000;
export const HEARTBEAT_PATH = "_server_health/heartbeat";
export const RULES_FILE = path.resolve(process.cwd(), "firebase", "database.rules.json");

/** The part of the Admin SDK database handle these checks use. */
export interface RealtimeDb {
  ref(path: string): {
    set(value: unknown): Promise<void>;
    get(): Promise<{ val(): unknown }>;
  };
  getRulesJSON(): Promise<object>;
}

export type FirebaseCheck =
  | { status: "ok"; latencyMs: number }
  | { status: "not_configured" }
  | { status: "failed"; latencyMs: number; error: string };

export type RulesCheck =
  | { status: "same" }
  | { status: "different"; changedKeys: string[] }
  | { status: "not_configured" }
  | { status: "failed"; error: string };

class TimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`${what}: no answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function defaultRealtimeDb(): RealtimeDb | null {
  const app = getFirebaseAdminApp();
  return app ? (getDatabaseWithUrl(FIREBASE_DATABASE_URL, app) as unknown as RealtimeDb) : null;
}

/** Never throws. */
export async function checkFirebaseHeartbeat(
  getDb: () => RealtimeDb | null = defaultRealtimeDb,
  now: () => number = Date.now,
  timeoutMs: number = FIREBASE_TIMEOUT_MS,
): Promise<FirebaseCheck> {
  const started = now();
  let db: RealtimeDb | null;
  try {
    db = getDb();
  } catch (err: unknown) {
    return { status: "failed", latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (!db) return { status: "not_configured" };

  const stamp = started;
  try {
    const ref = db.ref(HEARTBEAT_PATH);
    await withTimeout(ref.set({ at: stamp, pid: process.pid }), timeoutMs, "write");
    const snap = await withTimeout(ref.get(), timeoutMs, "read back");
    const at = (snap.val() as { at?: unknown } | null)?.at;
    if (at !== stamp) {
      return { status: "failed", latencyMs: now() - started, error: `read back ${String(at)} instead of ${stamp}` };
    }
    return { status: "ok", latencyMs: now() - started };
  } catch (err: unknown) {
    return { status: "failed", latencyMs: now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Same JSON regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Top-level paths under "rules" whose definition differs (including added or removed ones). */
export function changedRuleKeys(live: unknown, reviewed: unknown): string[] {
  const a = ((live as { rules?: Record<string, unknown> })?.rules ?? {}) as Record<string, unknown>;
  const b = ((reviewed as { rules?: Record<string, unknown> })?.rules ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => canonical(a[k]) !== canonical(b[k]));
}

/** Never throws. */
export async function checkFirebaseRules(
  getDb: () => RealtimeDb | null = defaultRealtimeDb,
  readReviewed: () => Promise<string> = () => readFile(RULES_FILE, "utf8"),
  timeoutMs: number = FIREBASE_TIMEOUT_MS * 2,
): Promise<RulesCheck> {
  try {
    const db = getDb();
    if (!db) return { status: "not_configured" };
    const [live, reviewedText] = await Promise.all([withTimeout(db.getRulesJSON(), timeoutMs, "rules"), readReviewed()]);
    const changedKeys = changedRuleKeys(live, JSON.parse(reviewedText));
    return changedKeys.length === 0 ? { status: "same" } : { status: "different", changedKeys };
  } catch (err: unknown) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
