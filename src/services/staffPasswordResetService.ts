import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { normalizeEmail, looksLikeEmail } from "../lib/identity.js";
import { emailVerificationRepository } from "../repositories/emailVerificationRepository.js";
import { passwordResetRepository } from "../repositories/passwordResetRepository.js";
import { accountAuditRepository } from "../repositories/accountAuditRepository.js";
import { sendEmail } from "../lib/mailer.js";
import { renderCodeBlock, renderDetailRows, renderEmailShell, renderSecurityAdvisory } from "../lib/emailTemplates.js";
import { verifyFirebaseIdToken } from "../lib/firebaseAdmin.js";
import { maskEmail, maskPhone } from "./loginChallengeService.js";
import { isIpThrottled } from "./passwordResetService.js";
import { describeDevice, PASSWORD_RESET_AUDIT } from "./loginNotificationService.js";
import * as sessionService from "./sessionService.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "./ServiceError.js";
import { JWT_PASSWORD_RESET_SECRET, PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS } from "../config/env.js";

// "Forgot password" for the staff web portal, in four moves:
//
//   1. findAccount  - email or mobile number in, the account's name and its
//                     verified channels out, plus a short-lived session token
//   2. sendCode     - EMAIL: a 6-digit code is mailed. SMS: the browser sends
//                     the SMS itself through Firebase; the server only mails the
//                     account a warning that a reset has started
//   3. verify       - code or Firebase phone token in, reset token out
//   4. complete     - reset token and new password in, every session revoked
//
// Unlike the customer flow (passwordResetService), step 1 tells the caller
// whether the account exists and shows its full name. That was a product
// decision (2026-10-16): staff recognise their own name faster than a masked
// one. What keeps it from becoming a staff directory is the throttle: every
// lookup, hit or miss, is written to password_reset_attempts with the IP, and
// isIpThrottled shuts an IP out after a handful of misses or distinct names.
//
// Each surface finds only the accounts that can sign in there: the web portal
// OWNER and DISPATCHER (/auth/password-reset), the rider app RIDER
// (/riders/password-reset, added 2026-10-16). Everyone else gets the same
// answer as an address nobody uses, and the `aud` claim stops a token minted
// for one surface from being spent on the other's routes.
//
// A code is only ever sent to a channel the account has VERIFIED, and the
// account's phone number never leaves the server: for SMS the person types
// their number, Firebase proves they hold it, and step 3 checks it against the
// account. Showing a stranger the full name is the agreed cost; handing them
// the number as well is not.

export type ResetAudience = "WEB_PORTAL" | "RIDER_APP";
const ROLES_FOR: Record<ResetAudience, readonly string[]> = {
  WEB_PORTAL: ["OWNER", "DISPATCHER"],
  RIDER_APP: ["RIDER"],
};
const SESSION_PURPOSE = "STAFF_PASSWORD_RESET_SESSION";
const RESET_PURPOSE = "STAFF_PASSWORD_RESET";
const SESSION_EXPIRES_IN_SECONDS = 15 * 60;

// The same rules as the staff sign-in OTP (staffVerificationService).
const CODE_LENGTH = 6;
const CODE_EXPIRY_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;
export const STAFF_RESET_RESEND_COOLDOWN_SECONDS = 60;

const notFoundMessage = (audience: ResetAudience) =>
  `We couldn't find a ${audience === "RIDER_APP" ? "rider" : "portal"} account with that email address or mobile number.`;
const SESSION_EXPIRED_MESSAGE = "Your password reset session expired. Please start again.";

export type ResetChannel = "EMAIL" | "SMS";

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  // The rider app's handset model, for "Requested from" in the emails.
  deviceHint?: string | null;
}

export interface FoundAccount {
  resetSessionToken: string;
  fullName: string;
  // Masked, and present only when that channel is verified and usable.
  maskedEmail: string | null;
  maskedPhone: string | null;
  expiresInSeconds: number;
}

export type SendCodeResult =
  | { channel: "EMAIL"; maskedEmail: string; expiresInSeconds: number; resendAfterSeconds: number }
  | { channel: "SMS"; maskedPhone: string };

interface SessionClaims {
  id: number;
  purpose: typeof SESSION_PURPOSE;
  cs: string;
  aud: ResetAudience;
}

interface ResetClaims {
  id: number;
  purpose: typeof RESET_PURPOSE;
  cs: string;
  via: ResetChannel;
  aud: ResetAudience;
}

type StaffRow = NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;

// The customer flow shares password_reset_attempts, so its per-IP throttle
// counts both. The prefix keeps the per-identifier cooldown streaks apart: a
// customer and a staff member who type the same address are different people.
//
// Once an account is found, every row is keyed by its id rather than by what
// was typed. countDistinctIdentifiers counts every row, so keying a finished
// reset by "the email" for one step and "the username" for the next would make
// one honest person look like two names probed. Misses keep the typed text,
// which is the part worth reading afterwards.
function accountKey(user: StaffRow): string {
  return `#${user.id}`;
}

function audit(outcome: string, identifier: string, ctx: RequestContext) {
  void passwordResetRepository
    .create({
      identifier: `staff:${identifier.trim().toLowerCase()}`.slice(0, 255),
      customerId: null,
      outcome,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
    .catch((err) => logger.error("[STAFF PASSWORD RESET] Failed to write audit row:", err));
}

function lastTenDigits(value: string | null | undefined): string {
  const digits = (value || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// The only numbers Firebase can text here: a Philippine mobile, 9XXXXXXXXX.
function isPhilippineMobile(phone: string | null | undefined): boolean {
  return /^9\d{9}$/.test(lastTenDigits(phone));
}

function fullNameOf(user: Pick<StaffRow, "firstName" | "lastName" | "username">): string {
  return `${user.firstName} ${user.lastName}`.trim() || user.username;
}

// Binds a token to the account state it was issued against. A password, role,
// status, email or phone change kills every outstanding token, and so does the
// reset itself: once the password hash changes, the reset token that set it
// can never be replayed.
function credentialStamp(user: StaffRow): string {
  return crypto
    .createHash("sha256")
    .update(
      `${user.passwordHash}|${user.role}|${user.status}|${(user.email || "").toLowerCase()}|${lastTenDigits(user.phone)}`
    )
    .digest("hex")
    .slice(0, 32);
}

function isEligible(user: StaffRow | null, audience: ResetAudience): user is StaffRow {
  return Boolean(user) && ROLES_FOR[audience].includes(String(user!.role)) && user!.status === "Active";
}

function describeRequester(ctx: RequestContext, audience: ResetAudience): string {
  return describeDevice({ ...ctx, deviceHint: ctx.deviceHint ?? null, channel: audience });
}

function emailOffered(user: StaffRow): boolean {
  return user.emailVerified && Boolean((user.email || "").trim());
}

// A number shared by two accounts proves nothing about which one is asking,
// so it is not offered at all (the customer flow learned this on 2026-10-09).
async function phoneOffered(user: StaffRow): Promise<boolean> {
  if (!user.phoneVerified || !isPhilippineMobile(user.phone)) return false;
  const target = lastTenDigits(user.phone);
  const others = await prisma.user.findMany({
    where: { id: { not: user.id } },
    select: { phone: true },
  });
  return !others.some((other) => lastTenDigits(other.phone) === target);
}

async function lookUp(identifier: string, audience: ResetAudience): Promise<StaffRow | null> {
  if (looksLikeEmail(identifier)) {
    const user = await prisma.user.findFirst({ where: { email: normalizeEmail(identifier) } });
    return isEligible(user, audience) ? user : null;
  }

  const target = lastTenDigits(identifier);
  const candidates = await prisma.user.findMany({
    where: { role: { in: ROLES_FOR[audience] as any }, status: "Active" },
  });
  const matches = candidates.filter((user) => lastTenDigits(user.phone) === target);
  if (matches.length > 1) {
    throw new ServiceError(
      409,
      "More than one account uses this mobile number. Search with your email address instead."
    );
  }
  return matches[0] ?? null;
}

function signSession(user: StaffRow, audience: ResetAudience): string {
  const claims: SessionClaims = { id: user.id, purpose: SESSION_PURPOSE, cs: credentialStamp(user), aud: audience };
  return jwt.sign(claims, JWT_PASSWORD_RESET_SECRET, { expiresIn: SESSION_EXPIRES_IN_SECONDS });
}

// Everything about the caller comes from a fresh read, never from the token:
// the token only names the account and the state it was issued against.
async function openSession(resetSessionToken: string, audience: ResetAudience): Promise<StaffRow> {
  let claims: SessionClaims;
  try {
    claims = jwt.verify(resetSessionToken, JWT_PASSWORD_RESET_SECRET, { algorithms: ["HS256"] }) as SessionClaims;
  } catch {
    throw new ServiceError(400, SESSION_EXPIRED_MESSAGE);
  }
  if (claims.purpose !== SESSION_PURPOSE || !claims.id || claims.aud !== audience) {
    throw new ServiceError(400, SESSION_EXPIRED_MESSAGE);
  }
  const user = await prisma.user.findUnique({ where: { id: claims.id } });
  if (!isEligible(user, audience) || credentialStamp(user) !== claims.cs) {
    throw new ServiceError(400, SESSION_EXPIRED_MESSAGE);
  }
  return user;
}

/** Step 1. */
export async function findAccount(
  identifier: string,
  honeypot: string | undefined,
  ctx: RequestContext,
  audience: ResetAudience = "WEB_PORTAL"
): Promise<FoundAccount> {
  const clean = identifier.trim();

  // A field no person can see or reach. Filled means a form-filling bot; it is
  // told exactly what a miss is told.
  if (honeypot && honeypot.trim().length > 0) {
    logger.warn(`[STAFF PASSWORD RESET] Honeypot tripped from ${ctx.ipAddress || "unknown IP"}`);
    audit("HONEYPOT", clean, ctx);
    throw new ServiceError(404, notFoundMessage(audience));
  }

  if (await isIpThrottled(ctx.ipAddress)) {
    audit("THROTTLED", clean, ctx);
    throw new ServiceError(
      429,
      "Too many account lookups from this device. Please try again later."
    );
  }

  if (!looksLikeEmail(clean) && lastTenDigits(clean).length < 10) {
    throw new ServiceError(400, "Enter the email address or mobile number on your account.");
  }

  let user: StaffRow | null;
  try {
    user = await lookUp(clean, audience);
  } catch (err) {
    audit("UNKNOWN_ACCOUNT", clean, ctx);
    throw err;
  }
  if (!user) {
    audit("UNKNOWN_ACCOUNT", clean, ctx);
    throw new ServiceError(404, notFoundMessage(audience));
  }

  audit("ACCOUNT_FOUND", accountKey(user), ctx);
  return {
    resetSessionToken: signSession(user, audience),
    fullName: fullNameOf(user),
    maskedEmail: emailOffered(user) ? maskEmail(user.email) : null,
    maskedPhone: (await phoneOffered(user)) ? maskPhone(user.phone) : null,
    expiresInSeconds: SESSION_EXPIRES_IN_SECONDS,
  };
}

function generateCode(): string {
  return crypto.randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, "0");
}

function buildCodeEmail(code: string, user: StaffRow, ctx: RequestContext, audience: ResetAudience) {
  const name = fullNameOf(user);
  const device = describeRequester(ctx, audience);
  const text =
    `Hi ${name},\n\n` +
    `Someone asked to reset the password for your Sugo Express account (${user.username}).\n\n` +
    `Your password reset code is: ${code}\n` +
    `It expires in ${CODE_EXPIRY_MINUTES} minutes.\n\n` +
    `Requested from: ${device}, IP address ${ctx.ipAddress || "Unknown"}\n\n` +
    `If this was not you, do not share this code with anyone. Your password has not changed. ` +
    `Tell your system administrator.`;

  const html = renderEmailShell({
    title: "Reset Your Password",
    subtitle: `Hi ${name}, use this code to reset the password for ${user.username}.`,
    bodyHtml: `
      ${renderCodeBlock(code, CODE_EXPIRY_MINUTES)}
      ${renderDetailRows([
        { label: "Requested from", value: device },
        { label: "IP address", value: ctx.ipAddress || "Unknown" },
      ])}
      ${renderSecurityAdvisory(
        "Did not ask for this?",
        "Do not share this code with anyone. Your password has not changed. Tell your system administrator so they can check the account."
      )}
    `,
    footerNote: "Sugo Express staff will never ask you for this code.",
    categoryBadge: "PASSWORD RESET",
    preheader: `Your Sugo Express password reset code is ${code}. Valid for ${CODE_EXPIRY_MINUTES} minutes.`,
  });

  return { subject: "Your Sugo Express password reset code", text, html };
}

// The reminder that goes out when the code travels by SMS instead: the mailbox
// would otherwise never hear that a reset is under way.
function buildWarningEmail(user: StaffRow, maskedPhone: string, ctx: RequestContext, audience: ResetAudience) {
  const name = fullNameOf(user);
  const device = describeRequester(ctx, audience);
  const text =
    `Hi ${name},\n\n` +
    `A password reset was started for your Sugo Express account (${user.username}). ` +
    `A verification code is being sent by SMS to ${maskedPhone}.\n\n` +
    `Requested from: ${device}, IP address ${ctx.ipAddress || "Unknown"}\n\n` +
    `If this was you, no action is needed. If it was not, your password has not changed yet. ` +
    `Tell your system administrator immediately.`;

  const html = renderEmailShell({
    title: "Password Reset Started",
    subtitle: `Hi ${name}, a password reset was started for ${user.username}.`,
    bodyHtml: `
      ${renderDetailRows([
        { label: "Code sent by", value: `SMS to ${maskedPhone}` },
        { label: "Requested from", value: device },
        { label: "IP address", value: ctx.ipAddress || "Unknown" },
      ])}
      ${renderSecurityAdvisory(
        "Was this you?",
        "If you did not start this, your password has not changed yet. Tell your system administrator immediately."
      )}
    `,
    footerNote: "This is a reminder only. You do not need to reply.",
    categoryBadge: "SECURITY AUDIT",
    preheader: `A password reset was started for your Sugo Express account.`,
  });

  return { subject: "A password reset was started on your Sugo Express account", text, html };
}

/** Step 2. */
export async function sendCode(
  resetSessionToken: string,
  channel: ResetChannel,
  ctx: RequestContext,
  audience: ResetAudience = "WEB_PORTAL"
): Promise<SendCodeResult> {
  const user = await openSession(resetSessionToken, audience);

  if (channel === "SMS") {
    if (!(await phoneOffered(user))) {
      throw new ServiceError(400, "This account has no verified mobile number to text.");
    }
    const maskedPhone = maskPhone(user.phone);
    if ((user.email || "").trim()) {
      // Never awaited: the warning must not be the reason someone cannot reset.
      const { subject, text, html } = buildWarningEmail(user, maskedPhone, ctx, audience);
      void sendEmail(user.email, subject, text, html).catch((err) =>
        logger.error("[STAFF PASSWORD RESET] Warning email failed:", err)
      );
    }
    audit("SMS_REQUESTED", accountKey(user), ctx);
    return { channel: "SMS", maskedPhone };
  }

  if (!emailOffered(user)) {
    throw new ServiceError(400, "This account has no verified email address to send a code to.");
  }

  const existing = await emailVerificationRepository.findLatestActiveForUser(user.id);
  if (existing) {
    const ageSeconds = (Date.now() - existing.createdAt.getTime()) / 1000;
    if (ageSeconds < STAFF_RESET_RESEND_COOLDOWN_SECONDS) {
      const retryAfterSeconds = Math.ceil(STAFF_RESET_RESEND_COOLDOWN_SECONDS - ageSeconds);
      throw new ServiceError(
        429,
        `Please wait ${retryAfterSeconds} more second${retryAfterSeconds === 1 ? "" : "s"} before requesting another code.`,
        { code: "RESEND_COOLDOWN", retryAfterSeconds }
      );
    }
  }

  await emailVerificationRepository.consumeAllForUser(user.id);
  const code = generateCode();
  const record = await emailVerificationRepository.create({
    userId: user.id,
    email: normalizeEmail(user.email),
    codeHash: await bcrypt.hash(code, 10),
    expiresAt: new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000),
  });

  // Awaited, unlike the warning: without this mail there is no way forward.
  const { subject, text, html } = buildCodeEmail(code, user, ctx, audience);
  const delivered = await sendEmail(user.email, subject, text, html);
  if (!delivered) {
    await emailVerificationRepository.markConsumed(record.id);
    throw new ServiceError(
      503,
      "We couldn't email your reset code right now. Please try again shortly, or use your mobile number."
    );
  }

  audit("REQUESTED", accountKey(user), ctx);
  return {
    channel: "EMAIL",
    maskedEmail: maskEmail(user.email),
    expiresInSeconds: CODE_EXPIRY_MINUTES * 60,
    resendAfterSeconds: STAFF_RESET_RESEND_COOLDOWN_SECONDS,
  };
}

/** Step 3. Exactly one of `code` (email) or `firebaseIdToken` (SMS). */
export async function verify(
  resetSessionToken: string,
  proof: { code?: string; firebaseIdToken?: string },
  ctx: RequestContext,
  audience: ResetAudience = "WEB_PORTAL"
): Promise<{ resetToken: string; expiresInSeconds: number }> {
  const user = await openSession(resetSessionToken, audience);
  let via: ResetChannel;

  if (proof.firebaseIdToken) {
    const decoded = await verifyFirebaseIdToken(proof.firebaseIdToken);
    const matches =
      Boolean(decoded.phoneNumber) &&
      lastTenDigits(decoded.phoneNumber) === lastTenDigits(user.phone) &&
      (await phoneOffered(user));
    if (!matches) {
      audit("CODE_REJECTED", accountKey(user), ctx);
      throw new ServiceError(400, "That mobile number does not match the one on this account.");
    }
    via = "SMS";
  } else {
    if (!emailOffered(user)) {
      throw new ServiceError(400, "This account has no verified email address.");
    }
    const record = await emailVerificationRepository.findLatestActiveForUser(user.id);
    if (!record) {
      audit("CODE_REJECTED", accountKey(user), ctx);
      throw new ServiceError(400, "No reset code is waiting. Please send a new one.");
    }
    if (record.expiresAt < new Date()) {
      audit("CODE_REJECTED", accountKey(user), ctx);
      throw new ServiceError(400, "This code has expired. Please send a new one.");
    }
    if (record.attempts >= MAX_CODE_ATTEMPTS) {
      audit("CODE_REJECTED", accountKey(user), ctx);
      throw new ServiceError(429, "Too many incorrect attempts. Please send a new code.");
    }
    if (!(await bcrypt.compare(proof.code || "", record.codeHash))) {
      await emailVerificationRepository.incrementAttempts(record.id);
      audit("CODE_REJECTED", accountKey(user), ctx);
      throw new ServiceError(400, "Incorrect code. Please check the email and try again.");
    }
    await emailVerificationRepository.markConsumed(record.id);
    via = "EMAIL";
  }

  audit("CODE_VERIFIED", accountKey(user), ctx);
  const claims: ResetClaims = { id: user.id, purpose: RESET_PURPOSE, cs: credentialStamp(user), via, aud: audience };
  return {
    resetToken: jwt.sign(claims, JWT_PASSWORD_RESET_SECRET, { expiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS }),
    expiresInSeconds: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
  };
}

/** Step 4. Returns the account so the caller can tell its open tabs to sign out. */
export async function complete(
  resetToken: string,
  newPassword: string,
  ctx: RequestContext,
  audience: ResetAudience = "WEB_PORTAL"
): Promise<{ userId: number; revokedSessions: number }> {
  let claims: ResetClaims;
  try {
    claims = jwt.verify(resetToken, JWT_PASSWORD_RESET_SECRET, { algorithms: ["HS256"] }) as ResetClaims;
  } catch {
    throw new ServiceError(400, SESSION_EXPIRED_MESSAGE);
  }
  // The secret is shared with the customer flow and with step 1's session
  // token; the purpose claim is what keeps either of those from landing here.
  if (claims.purpose !== RESET_PURPOSE || !claims.id || claims.aud !== audience) {
    throw new ServiceError(400, SESSION_EXPIRED_MESSAGE);
  }

  const user = await prisma.user.findUnique({ where: { id: claims.id } });
  if (!isEligible(user, audience)) {
    throw new ServiceError(400, SESSION_EXPIRED_MESSAGE);
  }
  if (credentialStamp(user) !== claims.cs) {
    throw new ServiceError(400, "This reset has already been used. Please start again.");
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new ServiceError(400, "Choose a password you have not used on this account before.");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
  });

  // Whoever might have been in the account loses it now.
  const revokedSessions = await sessionService.revokeAllForSubject("USER", user.id, "PASSWORD_RESET");

  // Awaited: this row is what makes the next sign-in send its "signed in with
  // your new password" email (loginNotificationService.sendLoginAlert).
  await accountAuditRepository.create({
    role: user.role,
    userId: user.id,
    fieldModified: PASSWORD_RESET_AUDIT.field,
    oldValue: null,
    newValue: PASSWORD_RESET_AUDIT.resetValue,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    verifiedVia: claims.via === "SMS" ? "SMS_OTP" : "EMAIL_OTP",
  });

  audit("COMPLETED", accountKey(user), ctx);
  logger.info(
    `[STAFF PASSWORD RESET] User #${user.id} reset their password by ${claims.via} from ${ctx.ipAddress || "unknown IP"}; ${revokedSessions} session(s) revoked.`
  );
  return { userId: user.id, revokedSessions };
}
