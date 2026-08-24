import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { emailVerificationRepository } from "../repositories/emailVerificationRepository.js";
import { sendEmail } from "../lib/mailer.js";
import { renderCodeBlock, renderEmailShell } from "../lib/emailTemplates.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "./ServiceError.js";

// First-login OTP for operational staff (Owner/Admin, Dispatcher, Rider).
//
// Intentionally a sibling of emailVerificationService rather than a branch
// inside it: that service is the customer-registration engine, keyed on
// customerId, and customers must be entirely unaffected by this feature. The
// two share the rules (6 digits, bcrypt-hashed at rest, 15-minute TTL, 5
// attempts) and the repository, not the control flow.

const CODE_LENGTH = 6;
const CODE_EXPIRY_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

// A sign-in retried within a minute reuses the code already in the person's
// inbox instead of mailing a second one and making them guess which is live.
const REUSE_WINDOW_SECONDS = 60;

function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(CODE_LENGTH, "0");
}

function buildEmail(code: string, name: string): { subject: string; text: string; html: string } {
  const greeting = name.trim() ? `Hi ${name.trim()},` : "Hi,";
  const text =
    `${greeting}\n\n` +
    `Your Sugo Express sign-in verification code is: ${code}\n\n` +
    `This is a one-time check to confirm this email address belongs to you. ` +
    `The code expires in ${CODE_EXPIRY_MINUTES} minutes.\n\n` +
    `If you did not try to sign in, contact your system administrator immediately.`;

  const html = renderEmailShell({
    title: "Verify Your Sign-In",
    subtitle: "Confirm this email address to finish setting up your staff account.",
    bodyHtml: renderCodeBlock(code, CODE_EXPIRY_MINUTES),
    footerNote:
      "If you did not try to sign in to Sugo Express, contact your system administrator immediately.",
  });

  return { subject: "Your Sugo Express Sign-In Verification Code", text, html };
}

// Writes the code row, then sends the mail and AWAITS it — unlike the customer
// registration path, which is deliberately fire-and-forget. Here a silently
// dropped email means a staff member cannot complete a sign-in at all and has
// no self-service way out, so the failure has to surface as an error.
async function issueCode(userId: number, email: string, name: string): Promise<void> {
  await emailVerificationRepository.consumeAllForUser(userId);

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  const record = await emailVerificationRepository.create({
    userId,
    email: email.toLowerCase().trim(),
    codeHash,
    expiresAt,
  });

  const { subject, text, html } = buildEmail(code, name);
  const delivered = await sendEmail(email, subject, text, html);

  if (!delivered) {
    // Retire the row we just wrote: leaving it live would let a later attempt
    // find an "active" code that nobody ever received.
    await emailVerificationRepository.markConsumed(record.id);
    logger.error(`[STAFF OTP] Delivery failed for user #${userId} <${email}>`);
    throw new ServiceError(
      503,
      "We couldn't email your verification code right now. Please try again shortly, or contact your system administrator."
    );
  }
}

export async function issueLoginOtp(userId: number, email: string, name: string): Promise<void> {
  const existing = await emailVerificationRepository.findLatestActiveForUser(userId);
  if (existing && existing.expiresAt > new Date()) {
    const ageSeconds = (Date.now() - existing.createdAt.getTime()) / 1000;
    if (ageSeconds < REUSE_WINDOW_SECONDS) {
      // Still fresh — the code in their inbox is the live one. Say nothing and
      // send nothing.
      return;
    }
  }
  await issueCode(userId, email, name);
}

// Same verification shape as the customer verifiers, so the two behave
// identically from a caller's point of view.
export async function verifyLoginOtp(userId: number, code: string): Promise<void> {
  const record = await emailVerificationRepository.findLatestActiveForUser(userId);
  if (!record) {
    throw new ServiceError(400, "No pending verification code found. Please request a new one.");
  }
  if (record.expiresAt < new Date()) {
    throw new ServiceError(400, "This code has expired. Please request a new one.");
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    throw new ServiceError(429, "Too many incorrect attempts. Please request a new code.");
  }

  const isMatch = await bcrypt.compare(code, record.codeHash);
  if (!isMatch) {
    await emailVerificationRepository.incrementAttempts(record.id);
    throw new ServiceError(400, "Incorrect verification code.");
  }

  await emailVerificationRepository.markConsumed(record.id);
}

export async function resendLoginOtp(userId: number, email: string, name: string): Promise<void> {
  const existing = await emailVerificationRepository.findLatestActiveForUser(userId);
  if (existing) {
    const ageSeconds = (Date.now() - existing.createdAt.getTime()) / 1000;
    if (ageSeconds < RESEND_COOLDOWN_SECONDS) {
      const retryAfterSeconds = Math.ceil(RESEND_COOLDOWN_SECONDS - ageSeconds);
      throw new ServiceError(
        429,
        `Please wait ${retryAfterSeconds} more second${retryAfterSeconds === 1 ? "" : "s"} before requesting another code.`,
        { code: "RESEND_COOLDOWN", retryAfterSeconds }
      );
    }
  }
  await issueCode(userId, email, name);
}

export const STAFF_OTP_RESEND_COOLDOWN_SECONDS = RESEND_COOLDOWN_SECONDS;
