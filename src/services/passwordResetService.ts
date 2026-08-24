import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { customerRepository } from "../repositories/customerRepository.js";
import { emailVerificationRepository } from "../repositories/emailVerificationRepository.js";
import { passwordResetRepository } from "../repositories/passwordResetRepository.js";
import { sendPasswordResetCode } from "./emailVerificationService.js";
import { maskEmail } from "./loginChallengeService.js";
import { evaluateResend, streakSince } from "./otpCooldownPolicy.js";
import * as sessionService from "./sessionService.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "./ServiceError.js";
import {
  JWT_PASSWORD_RESET_SECRET,
  PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
  PASSWORD_RESET_IP_WINDOW_MINUTES,
  PASSWORD_RESET_IP_MAX_MISSES,
} from "../config/env.js";

// Customer-facing password reset, in three moves:
//
//   1. requestReset      — identifier in, code mailed out (if the account exists)
//   2. verifyResetCode   — code in, short-lived reset token out
//   3. completeReset     — token + new password in, password changed
//
// Two rules shape everything below.
//
// ENUMERATION: step 1 returns the identical response whether or not the account
// exists. A "no such user" message turns this endpoint into a free membership
// oracle — an attacker learns which usernames are real without ever touching a
// password. The cost of hiding it is that a customer who mistypes their own
// username waits for an email that never comes; the audit log is what lets an
// operator tell those two cases apart after the fact.
//
// LOGGING: every step writes a PasswordResetAttempt row carrying the IP. Misses
// are recorded as carefully as hits, because a miss is the interesting event.

const MAX_CODE_ATTEMPTS = 5;
const PURPOSE = "PASSWORD_RESET";

export type ResetOutcome =
  | "REQUESTED"
  | "UNKNOWN_ACCOUNT"
  | "HONEYPOT"
  | "THROTTLED"
  // A second request for an account whose previous code is still fresh. Not an
  // error — the customer is told the same thing either way — but recorded
  // separately so "asked twice" is distinguishable from "asked once".
  | "COOLDOWN"
  | "CODE_VERIFIED"
  | "CODE_REJECTED"
  | "COMPLETED";

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

// What every caller of step 1 gets back, hit or miss.
export interface ResetRequestResult {
  message: string;
  // Seconds before a resend is worth offering. Computed from the AUDIT trail,
  // not from whether a code was actually sent, so a real and an imaginary
  // account quote the same wait after the same number of tries — otherwise the
  // countdown itself would answer the question the generic message refuses to.
  retryAfterSeconds: number;
  // Present only on a real hit, and only ever masked — "ju**@gmail.com" tells
  // the right person which mailbox to open without telling the wrong person
  // anything they did not already type in.
  maskedEmail: string | null;
}

interface ResetClaims {
  id: number;
  purpose: typeof PURPOSE;
  cs: string;
}

// The response is a constant, defined once, so the two branches physically
// cannot drift into saying different things.
const GENERIC_REQUEST_MESSAGE =
  "If that account exists, we've sent a 6-digit code to its email address.";

function log(outcome: ResetOutcome, identifier: string, ctx: RequestContext, customerId?: number | null) {
  // Fire-and-forget: an audit write must never be the reason a customer cannot
  // reset their password. A failure here is logged and swallowed.
  void passwordResetRepository
    .create({
      identifier: identifier.slice(0, 255).toLowerCase(),
      customerId: customerId ?? null,
      outcome,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
    .catch((err) => logger.error("[PASSWORD RESET] Failed to write audit row:", err));
}

// Binds the reset token to the password it was issued against. Once the
// password changes the stamp stops matching, so a token cannot be replayed to
// set the password a second time — and a token minted before an unrelated
// password change is dead on arrival.
function credentialStamp(passwordHash: string): string {
  return crypto.createHash("sha256").update(passwordHash).digest("hex").slice(0, 32);
}

/**
 * Step 1. Always resolves with the same message. The only branch a caller can
 * observe is `maskedEmail`, which is null unless the account is real — the
 * mobile client uses it for display and must not treat null as an error.
 */
export async function requestReset(
  identifier: string,
  honeypot: string | undefined,
  ctx: RequestContext
): Promise<ResetRequestResult> {
  const clean = identifier.trim();

  // HONEYPOT. The client renders an off-screen field no human can see or tab
  // into; a form-filling bot populates every input it finds. A filled value is
  // therefore not a user mistake, it is a robot signature. We record it and
  // return the same success text — telling the bot it was caught only teaches
  // whoever wrote it to stop filling that field.
  if (honeypot && honeypot.trim().length > 0) {
    logger.warn(
      `[PASSWORD RESET] Honeypot tripped from ${ctx.ipAddress || "unknown IP"} for "${clean}"`
    );
    log("HONEYPOT", clean, ctx);
    return { message: GENERIC_REQUEST_MESSAGE, maskedEmail: null, retryAfterSeconds: 0 };
  }

  if (await isIpThrottled(ctx.ipAddress)) {
    logger.warn(
      `[PASSWORD RESET] Throttled ${ctx.ipAddress} — too many fruitless attempts in the last ${PASSWORD_RESET_IP_WINDOW_MINUTES}m`
    );
    log("THROTTLED", clean, ctx);
    // Throttling IS observable, unlike the enumeration branch: a blocked caller
    // has to be told to stop, and the information it leaks ("you are blocked")
    // is about the caller, not about which accounts exist.
    throw new ServiceError(
      429,
      "Too many password reset attempts from this device. Please try again later."
    );
  }

  // The streak is measured before this request is logged, and measured against
  // the identifier rather than the account — see countRecentRequestsForIdentifier.
  const since = streakSince();
  const [requestCount, lastRequest] = await Promise.all([
    passwordResetRepository.countRecentRequestsForIdentifier(clean, since),
    passwordResetRepository.findLatestRequestForIdentifier(clean),
  ]);
  const lastRequestedAt = lastRequest && lastRequest.createdAt >= since ? lastRequest.createdAt : null;
  const { allowed, retryAfterSeconds } = evaluateResend(lastRequestedAt, requestCount);

  const customer = await customerRepository.findByIdentifier(clean);

  if (!customer) {
    // The row that matters. No account matched, so somebody typed an identifier
    // that does not exist — once, that is a typo; repeatedly, it is a search.
    log("UNKNOWN_ACCOUNT", clean, ctx);
    return { message: GENERIC_REQUEST_MESSAGE, maskedEmail: null, retryAfterSeconds };
  }

  if (customer.status !== "Active") {
    // Same shape as the miss on purpose: a deactivated account must not be
    // distinguishable from a non-existent one.
    log("UNKNOWN_ACCOUNT", clean, ctx, customer.id);
    return { message: GENERIC_REQUEST_MESSAGE, maskedEmail: null, retryAfterSeconds };
  }

  // Still inside the wait means a code is already sitting in the customer's
  // inbox. Re-issuing would RETIRE it (see sendPasswordResetCode), so someone
  // who navigated back and pressed the button again would find the code they
  // were looking at no longer works. Hand back the same response and leave the
  // existing code alone.
  if (!allowed) {
    log("COOLDOWN", clean, ctx, customer.id);
    return {
      message: GENERIC_REQUEST_MESSAGE,
      maskedEmail: maskEmail(customer.email),
      retryAfterSeconds,
    };
  }

  await sendPasswordResetCode(customer.id, customer.email);
  log("REQUESTED", clean, ctx, customer.id);

  return {
    message: GENERIC_REQUEST_MESSAGE,
    maskedEmail: maskEmail(customer.email),
    retryAfterSeconds,
  };
}

/**
 * Step 2. Checks the emailed code and, on success, mints the token that step 3
 * requires. Without this token /reset-password is unreachable, which is what
 * stops the flow from being "name an account, set its password".
 */
export async function verifyResetCode(
  identifier: string,
  code: string,
  ctx: RequestContext
): Promise<{ resetToken: string; expiresInSeconds: number }> {
  const clean = identifier.trim();
  const customer = await customerRepository.findByIdentifier(clean);

  // Beyond this point the messages are specific. That is deliberate and safe:
  // reaching here at all requires already holding a code from the mailbox.
  if (!customer) {
    log("CODE_REJECTED", clean, ctx);
    throw new ServiceError(400, "That code is not valid. Please request a new one.");
  }

  const record = await emailVerificationRepository.findLatestActiveForCustomer(customer.id);
  if (!record) {
    log("CODE_REJECTED", clean, ctx, customer.id);
    throw new ServiceError(400, "No pending reset code found. Please request a new one.");
  }
  if (record.expiresAt < new Date()) {
    log("CODE_REJECTED", clean, ctx, customer.id);
    throw new ServiceError(400, "This code has expired. Please request a new one.");
  }
  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    log("CODE_REJECTED", clean, ctx, customer.id);
    throw new ServiceError(429, "Too many incorrect attempts. Please request a new code.");
  }

  const isMatch = await bcrypt.compare(code, record.codeHash);
  if (!isMatch) {
    await emailVerificationRepository.incrementAttempts(record.id);
    log("CODE_REJECTED", clean, ctx, customer.id);
    throw new ServiceError(400, "Incorrect code.");
  }

  await emailVerificationRepository.markConsumed(record.id);
  log("CODE_VERIFIED", clean, ctx, customer.id);

  const claims: ResetClaims = {
    id: customer.id,
    purpose: PURPOSE,
    cs: credentialStamp(customer.passwordHash),
  };
  const resetToken = jwt.sign(claims, JWT_PASSWORD_RESET_SECRET, {
    expiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
  });

  return { resetToken, expiresInSeconds: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS };
}

/**
 * Step 3. Sets the new password. The mailbox proof happened in step 2 and is
 * carried here by the token alone.
 */
export async function completeReset(
  resetToken: string,
  newPassword: string,
  ctx: RequestContext
): Promise<void> {
  let claims: ResetClaims;
  try {
    claims = jwt.verify(resetToken, JWT_PASSWORD_RESET_SECRET) as ResetClaims;
  } catch {
    throw new ServiceError(400, "This reset session has expired. Please start again.");
  }

  // A token signed with the right key but minted for something else must not be
  // accepted — the purpose claim is the check that keeps the key's blast radius
  // to this one operation.
  if (claims.purpose !== PURPOSE) {
    throw new ServiceError(400, "This reset session is not valid. Please start again.");
  }

  const customer = await customerRepository.findById(claims.id);
  if (!customer) {
    throw new ServiceError(400, "This reset session is no longer valid. Please start again.");
  }

  if (claims.cs !== credentialStamp(customer.passwordHash)) {
    throw new ServiceError(
      400,
      "This reset link has already been used. Please request a new code."
    );
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await customerRepository.update(customer.id, { passwordHash });

  // Sign out every device. Resetting a password is the one action that says
  // "someone may be in my account", and before sessions existed there was
  // nothing to act on — a thief holding a refresh token kept it through the
  // reset. Now the reset is what takes it away, and it matters more at a 30-day
  // session length than it did at 7.
  const revokedSessions = await sessionService.revokeAllForSubject(
    "CUSTOMER",
    customer.id,
    "PASSWORD_RESET"
  );
  if (revokedSessions > 0) {
    logger.info(
      `[PASSWORD RESET] Revoked ${revokedSessions} session(s) for customer #${customer.id}.`
    );
  }

  log("COMPLETED", customer.username, ctx, customer.id);
  logger.info(`[PASSWORD RESET] Customer #${customer.id} completed a reset from ${ctx.ipAddress || "unknown IP"}`);
}

/**
 * True once an IP has produced too many fruitless attempts, or probed too many
 * distinct identifiers, inside the window.
 *
 * The second test is the one that catches enumeration. A patient script pacing
 * itself under the route's rate limit still has to name a different account
 * each time, and that is the signature this counts.
 */
export async function isIpThrottled(ipAddress: string | null): Promise<boolean> {
  // No IP means no key to count against — do not block, since the alternative
  // is refusing every request from a misconfigured proxy.
  if (!ipAddress) return false;

  const since = new Date(Date.now() - PASSWORD_RESET_IP_WINDOW_MINUTES * 60 * 1000);
  const [misses, distinctIdentifiers] = await Promise.all([
    passwordResetRepository.countRecentMisses(ipAddress, since),
    passwordResetRepository.countDistinctIdentifiers(ipAddress, since),
  ]);

  return misses >= PASSWORD_RESET_IP_MAX_MISSES || distinctIdentifiers > PASSWORD_RESET_IP_MAX_MISSES;
}

// Read side of the audit trail. Nothing mounts these yet — the Owner Portal
// screen that would show them is not built. They are exported rather than
// inlined so that screen is a route away, and so the log is reachable from a
// REPL or a script in the meantime.
export function listRecentAttempts(limit?: number) {
  return passwordResetRepository.listRecent(limit);
}

export function listAttemptsForIp(ipAddress: string, limit?: number) {
  return passwordResetRepository.listRecentForIp(ipAddress, limit);
}
