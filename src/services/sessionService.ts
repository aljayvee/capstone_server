import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";
import { REFRESH_SESSION_TTL_MS, REFRESH_ROTATION_GRACE_MS } from "../config/env.js";

/**
 * Session lifecycle for rotating refresh tokens.
 *
 * The problem this solves: a refresh token is a bearer credential with a very
 * long life. Extending it to 30 days so the Customer and Rider apps stop
 * logging people out every hour also extends, by the same factor, how long a
 * stolen one keeps working. Rotation is what pays for that.
 *
 * The rule is simple. Each refresh token may be used exactly once. Using it
 * mints a replacement and invalidates the old one. If a token that has already
 * been rotated away comes back, two parties hold the same credential — the
 * legitimate client and someone else — and there is no way to tell which one is
 * asking. The only safe response is to revoke the whole session and make the
 * real user sign in again, which is exactly what `assertNotReplayed` does.
 */

export type SubjectType = "USER" | "CUSTOMER" | "SYSADMIN";

export interface SessionContext {
  deviceId?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface SessionSubject {
  id: number;
  role: string;
  subjectType: SubjectType;
}

/**
 * SHA-256 hex of a token.
 *
 * The refresh token itself is never persisted. If this table leaks, the
 * attacker holds hashes of credentials that have already been rotated away,
 * not credentials — the same reason password hashes exist.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** A customer id, staff id, or sysadmin id may collide; the pair is the real identity. */
export function subjectTypeForRole(role: string): SubjectType {
  const norm = String(role).toUpperCase();
  if (norm === "CUSTOMER") return "CUSTOMER";
  if (norm === "SYSADMIN") return "SYSADMIN";
  return "USER";
}

function expiryFromNow(): Date {
  return new Date(Date.now() + REFRESH_SESSION_TTL_MS);
}

/** Opens a session at sign-in. The caller mints the token against `id`. */
export async function createSession(
  sessionId: string,
  subject: SessionSubject,
  refreshToken: string,
  context: SessionContext = {}
): Promise<void> {
  await prisma.userSession.create({
    data: {
      id: sessionId,
      subjectId: subject.id,
      subjectType: subject.subjectType,
      role: String(subject.role).toUpperCase(),
      tokenHash: hashToken(refreshToken),
      deviceId: context.deviceId?.slice(0, 80) ?? null,
      userAgent: context.userAgent?.slice(0, 300) ?? null,
      ipAddress: context.ipAddress?.slice(0, 64) ?? null,
      expiresAt: expiryFromNow(),
    },
  });
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  // updateMany, not update: revoking a session that is already gone is the
  // outcome the caller wanted and must not throw.
  await prisma.userSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason.slice(0, 64) },
  });
}

/** Signs every device of one account out. Used on password reset. */
export async function revokeAllForSubject(
  subjectType: SubjectType,
  subjectId: number,
  reason: string
): Promise<number> {
  const result = await prisma.userSession.updateMany({
    where: { subjectType, subjectId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason.slice(0, 64) },
  });
  return result.count;
}

/** Finds any currently unrevoked, unexpired session for a staff member (OWNER/DISPATCHER) */
export async function findActiveStaffSession(subjectId: number, role: string) {
  const normalizedRole = role.toUpperCase();
  if (normalizedRole !== "OWNER" && normalizedRole !== "DISPATCHER") {
    return null;
  }
  return prisma.userSession.findFirst({
    where: {
      subjectId,
      subjectType: "USER",
      role: normalizedRole,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { lastUsedAt: "desc" },
  });
}

/**
 * Retires any live session belonging to the SAME device as the caller.
 *
 * The single-device guard identifies "another device" as nothing more than "an
 * active session exists for this user and role" — it compares no device, IP or
 * user agent at all. Combined with 30-day sessions that nothing prunes, that
 * made a dispatcher signing in from the browser they always use get challenged
 * about themselves, and superseding their own earlier session then signed out
 * any tab still holding it with "This session has been signed out." It is by
 * far the most common revocation in production: 53 of them against a handful of
 * staff accounts by 2026-09-23.
 *
 * Signing in again on a device you are already signed in on is not a takeover.
 * It is the same person on the same machine, so the old session is retired
 * quietly and the prompt is saved for a genuinely different device.
 *
 * Only ever matches a POSITIVE device id. A session recorded before the web
 * portal sent one carries NULL and is deliberately left alone, so this can
 * never quietly retire a session it cannot prove belongs to this browser.
 */
export async function revokeSameDeviceSessions(
  subjectId: number,
  subjectType: SubjectType,
  deviceId: string,
  reason: string
): Promise<number> {
  const trimmed = deviceId.slice(0, 80);
  if (!trimmed) return 0;

  const result = await prisma.userSession.updateMany({
    where: { subjectId, subjectType, deviceId: trimmed, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason.slice(0, 64) },
  });
  return result.count;
}

/** Lists all active sessions for a subject */
export async function listActiveSessions(subjectId: number, subjectType: SubjectType) {
  return prisma.userSession.findMany({
    where: {
      subjectId,
      subjectType,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { lastUsedAt: "desc" },
  });
}

/** Revokes all active sessions for a subject except the specified session */
export async function revokeOtherSessions(
  subjectId: number,
  subjectType: SubjectType,
  keepSessionId: string,
  reason: string
): Promise<number> {
  const result = await prisma.userSession.updateMany({
    where: {
      subjectId,
      subjectType,
      id: { not: keepSessionId },
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
      revokedReason: reason.slice(0, 64),
    },
  });
  return result.count;
}

/** Revokes ALL active sessions for a subject */
export async function revokeAllSubjectSessions(
  subjectId: number,
  subjectType: SubjectType,
  reason: string
): Promise<number> {
  const result = await prisma.userSession.updateMany({
    where: {
      subjectId,
      subjectType,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
      revokedReason: reason.slice(0, 64),
    },
  });
  return result.count;
}

/** Records an entry in account_login_logs for audit tracking */
export async function recordLoginLog(data: {
  userId: number;
  role: string;
  ipAddress: string;
  userAgent: string;
  deviceInfo?: string | null;
  status: string;
  sessionId?: string | null;
  revokedReason?: string | null;
}): Promise<void> {
  try {
    await prisma.accountLoginLog.create({
      data: {
        userId: data.userId,
        role: data.role.toUpperCase(),
        ipAddress: data.ipAddress.slice(0, 64),
        userAgent: data.userAgent.slice(0, 300),
        deviceInfo: data.deviceInfo?.slice(0, 120) ?? null,
        status: data.status.slice(0, 32),
        sessionId: data.sessionId?.slice(0, 36) ?? null,
        revokedReason: data.revokedReason?.slice(0, 64) ?? null,
        isOnline: data.status.toUpperCase() === "SUCCESS",
      },
    });
  } catch (err) {
    // Non-fatal: an audit failure must never break sign-in or session flows
    console.error("[SessionService] Failed to record login log:", err);
  }
}

/** Updates isOnline flag in account_login_logs for the user's active login records */
export async function updateUserPresenceLog(userId: number, isOnline: boolean): Promise<void> {
  try {
    await prisma.accountLoginLog.updateMany({
      where: {
        userId,
        status: "SUCCESS",
        revokedAt: null,
      },
      data: { isOnline },
    });
  } catch (err) {
    console.error("[SessionService] Failed to update presence log:", err);
  }
}

/** Retrieves recent login audit history for a user */
export async function getAccountLoginLogs(userId: number, role: string, limit = 50) {
  return prisma.accountLoginLog.findMany({
    where: {
      userId,
      role: role.toUpperCase(),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 100),
  });
}

/**
 * Decide whether the presented token is the session's current one.
 *
 * Three outcomes, and the middle one is the whole point of the design:
 *
 *  - it matches `tokenHash`      → normal rotation
 *  - it matches `previousHash`
 *    and we are inside the grace
 *    window                      → a concurrent request from the same client,
 *                                  which is routine on a phone that fires
 *                                  several calls at once. Allowed, no rotation.
 *  - anything else               → this token was rotated away and has come
 *                                  back. Someone kept a copy. Kill the session.
 */
function classifyPresentedToken(
  session: { tokenHash: string; previousHash: string | null; rotatedAt: Date | null },
  presentedHash: string
): "current" | "grace" | "replay" {
  if (session.tokenHash === presentedHash) return "current";

  if (
    session.previousHash === presentedHash &&
    session.rotatedAt &&
    Date.now() - session.rotatedAt.getTime() <= REFRESH_ROTATION_GRACE_MS
  ) {
    return "grace";
  }

  return "replay";
}

export interface RotationOutcome {
  session: { id: number; role: string; subjectType: SubjectType };
  /** False when the grace window served the request; the client keeps its token. */
  rotated: boolean;
}

/**
 * Validate a presented refresh token against its session and rotate it.
 *
 * `mintReplacement` is a callback rather than a parameter because the new token
 * must embed the same `sid` and can only be signed by authService — but its
 * hash has to be written inside the same logical step that retires the old one.
 */
export async function rotateSession(
  sessionId: string,
  presentedToken: string,
  mintReplacement: () => string,
  context: SessionContext = {}
): Promise<{ outcome: RotationOutcome; refreshToken: string | null }> {
  const session = await prisma.userSession.findUnique({ where: { id: sessionId } });

  if (!session) {
    throw new ServiceError(401, "Session not found. Please log in again.");
  }
  if (session.revokedAt) {
    throw new ServiceError(401, "This session has been signed out. Please log in again.");
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new ServiceError(401, "Your session has expired. Please log in again.");
  }

  const presentedHash = hashToken(presentedToken);
  const verdict = classifyPresentedToken(session, presentedHash);

  if (verdict === "replay") {
    // Do not merely reject the request: the legitimate client is still holding
    // a working token, so rejecting one call would let the thief keep trying.
    // Burn the session for both of them.
    await revokeSession(sessionId, "REFRESH_TOKEN_REUSE");
    throw new ServiceError(
      401,
      "This session was signed out for your security. Please log in again."
    );
  }

  // Device binding. The mobile clients send a stable x-device-id, so a refresh
  // arriving from a different device on a session that recorded one means the
  // token moved. Only enforced when both sides are known — the web dashboard
  // sends no device id and must not be locked out by a null comparison.
  if (session.deviceId && context.deviceId && session.deviceId !== context.deviceId) {
    await revokeSession(sessionId, "DEVICE_MISMATCH");
    throw new ServiceError(
      401,
      "This session was signed out for your security. Please log in again."
    );
  }

  const subject = {
    id: session.subjectId,
    role: session.role,
    subjectType: session.subjectType as SubjectType,
  };

  if (verdict === "grace") {
    // A sibling request already rotated. Hand back a new access token without
    // moving the chain again, so the client's stored refresh token stays valid.
    await prisma.userSession.update({
      where: { id: sessionId },
      data: { lastUsedAt: new Date() },
    });
    return { outcome: { session: subject, rotated: false }, refreshToken: null };
  }

  const replacement = mintReplacement();

  // Sliding 30-day window: an app in regular use never reaches its expiry, and
  // one left untouched for 30 days requires a fresh sign-in.
  await prisma.userSession.update({
    where: { id: sessionId },
    data: {
      tokenHash: hashToken(replacement),
      previousHash: session.tokenHash,
      rotatedAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt: expiryFromNow(),
      // Refresh the display context so a session list shows where the account
      // is actually being used, not only where it first signed in.
      ipAddress: context.ipAddress?.slice(0, 64) ?? session.ipAddress,
      userAgent: context.userAgent?.slice(0, 300) ?? session.userAgent,
    },
  });

  return { outcome: { session: subject, rotated: true }, refreshToken: replacement };
}

/**
 * Housekeeping. Expired and long-revoked rows carry no security value — the
 * hashes in them refer to tokens that can no longer be presented.
 */
export async function deleteExpiredSessions(): Promise<number> {
  const cutoff = new Date();
  const result = await prisma.userSession.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: cutoff } },
        { revokedAt: { lt: new Date(cutoff.getTime() - 7 * 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return result.count;
}
