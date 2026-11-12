import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { MFA_ENFORCED_AUDIENCES, MFA_TRUST_DAYS } from "../config/env.js";

// "This device already passed MFA" for one account.
//
// A device that completes the second factor gets a random token. The server
// keeps only its sha256 (mfa_trusted_devices); the web keeps the token in an
// HttpOnly cookie and the mobile apps in SecureStore. A later sign-in that
// presents it skips the challenge until the row expires, is revoked, or its
// credential stamp stops matching the account.

export type TrustSubjectType = "USER" | "CUSTOMER";
export type TrustMethod = "SMS" | "EMAIL";

export interface TrustSubject {
  type: TrustSubjectType;
  id: number;
}

// The fields the stamp covers. Staff rows carry `phone` directly; customers
// keep it on customer_information, so callers pass the flattened value.
export interface StampSource {
  passwordHash: string | null;
  status: string;
  email: string | null;
  phone: string | null;
}

export const MFA_TRUST_COOKIE = "mfaTrust";
export const MFA_TRUST_TTL_MS = MFA_TRUST_DAYS * 24 * 60 * 60 * 1000;

// One browser is often shared by several staff accounts (the owner and a
// dispatcher on the office PC). The portal's cookie therefore carries one token
// per account, newest first, joined by "." (never part of a base64url token).
// With a single token, signing in as one account overwrote the other's trust
// and every switch asked for a code again (2026-11-04).
export const MFA_TRUST_COOKIE_MAX_TOKENS = 5;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,100}$/;

export function parseTrustCookie(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  const tokens = value.split(".").filter((token) => TOKEN_SHAPE.test(token));
  return [...new Set(tokens)].slice(0, MFA_TRUST_COOKIE_MAX_TOKENS);
}

export function serializeTrustCookie(newToken: string, keep: readonly string[]): string {
  return [newToken, ...keep.filter((token) => token !== newToken)].slice(0, MFA_TRUST_COOKIE_MAX_TOKENS).join(".");
}

// The tokens that still name a live trust, in their original order, so a
// cookie being rewritten drops the replaced, revoked and expired ones.
export async function liveTokens(tokens: readonly string[]): Promise<string[]> {
  if (tokens.length === 0) return [];
  const rows = await prisma.mfaTrustedDevice.findMany({
    where: { tokenHash: { in: tokens.map(sha256) }, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { tokenHash: true },
  });
  const live = new Set(rows.map((row) => row.tokenHash));
  return tokens.filter((token) => live.has(sha256(token)));
}

export function isMfaEnforced(audience: string): boolean {
  return MFA_ENFORCED_AUDIENCES.has(audience.toUpperCase());
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Changes when the password, status, email or phone changes, which ends the
// trust: a stolen trust token is worthless after a password reset, and a phone
// swapped by someone holding a session cannot ride an old trust.
export function trustStamp(source: StampSource): string {
  const phoneDigits = (source.phone || "").replace(/\D/g, "").slice(-10);
  return sha256(
    `${source.passwordHash || ""}|${source.status}|${(source.email || "").trim().toLowerCase()}|${phoneDigits}`
  ).slice(0, 32);
}

/**
 * True when one of `tokens` is a live trust for this account on this device.
 * The portal's cookie may hold other accounts' tokens too; those never match.
 *
 * The device id is a hint (see requestContext.getDeviceId): compared only when
 * both the row and the request carry one, and a mismatch can only refuse.
 */
export async function isTrusted(
  subject: TrustSubject,
  tokens: string | readonly string[] | null | undefined,
  deviceId: string | null,
  source: StampSource
): Promise<boolean> {
  const list = (typeof tokens === "string" ? [tokens] : tokens ?? [])
    .filter((token) => typeof token === "string" && token.length > 0 && token.length <= 200)
    .slice(0, MFA_TRUST_COOKIE_MAX_TOKENS + 1);
  if (list.length === 0) return false;

  const rows = await prisma.mfaTrustedDevice.findMany({ where: { tokenHash: { in: list.map(sha256) } } });
  const stamp = trustStamp(source);
  const row = rows.find(
    (candidate) =>
      candidate.subjectType === subject.type &&
      candidate.subjectId === subject.id &&
      !candidate.revokedAt &&
      candidate.expiresAt.getTime() > Date.now() &&
      !(candidate.deviceId && deviceId && candidate.deviceId !== deviceId) &&
      candidate.credStamp === stamp
  );
  if (!row) return false;

  // Bookkeeping only; a failed write must not fail the sign-in.
  void prisma.mfaTrustedDevice
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch((error) => logger.warn(`[MFA] lastUsedAt update failed: ${error?.message || error}`));
  return true;
}

/**
 * Trusts this device for MFA_TRUST_DAYS and returns the raw token, which the
 * caller hands to the client exactly once. A device trusted again replaces its
 * earlier row, so one device never holds two live trusts.
 */
export async function issue(
  subject: TrustSubject,
  source: StampSource,
  context: { deviceId: string | null; userAgent: string | null; method: TrustMethod }
): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();

  if (context.deviceId) {
    await prisma.mfaTrustedDevice.updateMany({
      where: { subjectType: subject.type, subjectId: subject.id, deviceId: context.deviceId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  await prisma.mfaTrustedDevice.create({
    data: {
      subjectType: subject.type,
      subjectId: subject.id,
      tokenHash: sha256(token),
      deviceId: context.deviceId,
      credStamp: trustStamp(source),
      method: context.method,
      userAgent: context.userAgent ? context.userAgent.slice(0, 300) : null,
      expiresAt: new Date(now.getTime() + MFA_TRUST_TTL_MS),
    },
  });

  return token;
}

/**
 * Forgets every trusted device of the account except the caller's, so "sign out
 * other devices" also makes them pass MFA again. The caller's device is kept by
 * the tokens it holds when it has any (the portal's cookie may carry several,
 * one per account), else by device id.
 */
export async function revokeOthers(
  subject: TrustSubject,
  keep: { tokens?: readonly string[]; deviceId?: string | null }
): Promise<number> {
  const keepHashes = (keep.tokens ?? []).filter(Boolean).map(sha256);
  const result = await prisma.mfaTrustedDevice.updateMany({
    where: {
      subjectType: subject.type,
      subjectId: subject.id,
      revokedAt: null,
      ...(keepHashes.length ? { NOT: { tokenHash: { in: keepHashes } } } : {}),
      // Spelled out with OR: a bare `not` would also skip rows with no device
      // id (the web's), leaving them trusted.
      ...(!keepHashes.length && keep.deviceId
        ? { OR: [{ deviceId: null }, { deviceId: { not: keep.deviceId } }] }
        : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
