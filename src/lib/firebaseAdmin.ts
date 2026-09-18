import { readFileSync } from "node:fs";
import { cert, getApps, initializeApp, type App, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { logger } from "./logger.js";
import { FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_PATH } from "../config/env.js";

/**
 * The Admin SDK, initialized once, for minting Firebase custom tokens.
 *
 * ## Why this exists
 *
 * Every client talked to the Realtime Database with no identity at all: the web
 * portal, the CustomerApp and the RiderMobileApp each called `getDatabase()` and
 * subscribed. That left exactly two possible rulesets — wide open, or broken —
 * and the project ran on the first until the rules were tightened, at which
 * point rider tracking, both chat channels and customer location sharing all
 * stopped at once with no error anywhere (the web's `onValue` had no error
 * callback, and the rider app's writes caught and discarded their own).
 *
 * With this, a signed-in user can prove who they are to Firebase using the
 * session they already hold, and the rules can finally say something more
 * useful than `true`.
 *
 * ## Why custom tokens rather than a second password
 *
 * MariaDB stays the identity authority. The user authenticates once, against
 * the existing JWT flow, which is a [LOCKED] contract and is not touched here.
 * This mints a SECOND, Firebase-shaped assertion of that same already-proven
 * identity. No new credential, no second sign-in, no duplicated user store.
 *
 * ## Degrading rather than crashing
 *
 * A missing service account disables token minting and leaves the rest of the
 * server running. Bringing the whole API down because a real-time convenience
 * is misconfigured would turn a degraded map into a total outage, which is a
 * strictly worse failure than the one this is fixing.
 */

let app: App | null = null;
let initializationError: string | null = null;

function loadServiceAccount(): ServiceAccount | null {
  // Inline JSON wins over a path so a container can supply it as one env var
  // without a mounted file.
  if (FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
    } catch {
      initializationError = "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.";
      return null;
    }
  }

  if (FIREBASE_SERVICE_ACCOUNT_PATH) {
    try {
      return JSON.parse(readFileSync(FIREBASE_SERVICE_ACCOUNT_PATH, "utf8")) as ServiceAccount;
    } catch {
      initializationError = `Could not read a service account from ${FIREBASE_SERVICE_ACCOUNT_PATH}.`;
      return null;
    }
  }

  initializationError =
    "No Firebase service account configured. Set FIREBASE_SERVICE_ACCOUNT_PATH or " +
    "FIREBASE_SERVICE_ACCOUNT_JSON to enable real-time authentication.";
  return null;
}

function ensureApp(): App | null {
  if (app) return app;
  if (initializationError) return null;

  // Another module may have initialized the default app already.
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0];
    return app;
  }

  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    logger.warn(`[Firebase Admin] ${initializationError}`);
    return null;
  }

  try {
    app = initializeApp({ credential: cert(serviceAccount) });
    logger.info("[Firebase Admin] initialized; real-time custom tokens are available.");
    return app;
  } catch (error) {
    initializationError = `Firebase Admin failed to initialize: ${String(error)}`;
    logger.error(`[Firebase Admin] ${initializationError}`);
    return null;
  }
}

export function isFirebaseConfigured(): boolean {
  return ensureApp() !== null;
}

/** Why token minting is unavailable, for an operator reading a health check. */
export function firebaseConfigurationError(): string | null {
  ensureApp();
  return app ? null : initializationError;
}

/**
 * The Firebase uid for one of our users.
 *
 * Namespaced by role because the two id spaces overlap: staff and riders are
 * rows in `users`, customers are rows in `customer_accounts`, and both start at
 * 1. An unprefixed numeric uid would make customer 3 and rider 3 the same
 * Firebase principal, and the rules would hand each of them the other's data.
 *
 * The prefixes are part of the security rules — `riders/$riderId` is writable
 * only by `rider_$riderId` — so changing one means changing both together.
 */
export function firebaseUidFor(role: string, id: number): string {
  const normalized = String(role || "").toUpperCase();
  if (normalized === "RIDER") return `rider_${id}`;
  if (normalized === "CUSTOMER") return `customer_${id}`;
  return `staff_${id}`;
}

export interface FirebaseTokenClaims {
  role: string;
  appUserId: number;
}

/**
 * A Firebase custom token for an already-authenticated caller.
 *
 * The claims are what the security rules read. `role` drives the staff/rider/
 * customer split and `appUserId` is carried so a rule can compare against a
 * numeric id without parsing the uid string back apart.
 *
 * Custom tokens are short-lived by design (one hour), but the session they
 * open is not: `signInWithCustomToken` yields an ID token the client SDK
 * refreshes on its own until sign-out. Clients therefore ask for one of these
 * at sign-in, not on a timer.
 */
export async function mintCustomToken(
  role: string,
  id: number
): Promise<{ token: string; uid: string; claims: FirebaseTokenClaims }> {
  const initialized = ensureApp();
  if (!initialized) {
    throw new Error(initializationError || "Firebase Admin is not configured.");
  }

  const uid = firebaseUidFor(role, id);
  const claims: FirebaseTokenClaims = {
    role: String(role || "").toUpperCase(),
    appUserId: id,
  };

  const token = await getAuth(initialized).createCustomToken(uid, claims);
  return { token, uid, claims };
}
