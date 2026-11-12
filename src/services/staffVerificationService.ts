import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { emailVerificationRepository } from "../repositories/emailVerificationRepository.js";
import { sendEmail } from "../lib/mailer.js";
import { renderCodeBlock, renderEmailShell } from "../lib/emailTemplates.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "./ServiceError.js";

// Sign-in email code: the first-login check for operational staff (Owner/Admin,
// Dispatcher, Rider), and the email half of MFA for staff and customers.
//
// Intentionally a sibling of emailVerificationService rather than a branch
// inside it: that service is the customer-registration engine, and its codes
// say "complete your registration". The two share the rules (6 digits,
// bcrypt-hashed at rest, 15-minute TTL, 5 attempts) and the repository, not the
// control flow. A customer's sign-in code lives on the same customerId rows as
// their reset code, under the same one-live-code rule.

type CodeOwner = { userId: number } | { customerId: number };

function retireAll(owner: CodeOwner) {
  return "userId" in owner
    ? emailVerificationRepository.consumeAllForUser(owner.userId)
    : emailVerificationRepository.consumeAllForCustomer(owner.customerId);
}

function findLatestActive(owner: CodeOwner) {
  return "userId" in owner
    ? emailVerificationRepository.findLatestActiveForUser(owner.userId)
    : emailVerificationRepository.findLatestActiveForCustomer(owner.customerId);
}

function ownerLabel(owner: CodeOwner): string {
  return "userId" in owner ? `user #${owner.userId}` : `customer #${owner.customerId}`;
}

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

function buildEmail(code: string, name: string, owner: CodeOwner): { subject: string; text: string; html: string } {
  const greeting = name.trim() ? `Hi ${name.trim()},` : "Hi,";
  const isStaff = "userId" in owner;
  const ifNotYou = isStaff
    ? "If you did not try to sign in, contact your system administrator immediately."
    : "If you did not try to sign in, change your Sugo Express password now. Someone may know it.";
  const text =
    `${greeting}\n\n` +
    `Your Sugo Express sign-in verification code is: ${code}\n\n` +
    `Enter it to finish signing in. ` +
    `The code expires in ${CODE_EXPIRY_MINUTES} minutes.\n\n` +
    ifNotYou;

  const html = renderEmailShell({
    title: "Verify Your Sign-In",
    subtitle: `${greeting} Enter this code to finish signing in to Sugo Express.`,
    bodyHtml: renderCodeBlock(code, CODE_EXPIRY_MINUTES),
    footerNote: ifNotYou,
    categoryBadge: isStaff ? "STAFF VERIFICATION" : "SIGN-IN VERIFICATION",
    preheader: `Your Sugo Express verification code is ${code}. Valid for ${CODE_EXPIRY_MINUTES} minutes.`,
  });

  return { subject: "Your Sugo Express Sign-In Verification Code", text, html };
}

// Writes the code row, then sends the mail and AWAITS it — unlike the customer
// registration path, which is deliberately fire-and-forget. Here a silently
// dropped email means the person cannot complete a sign-in at all and has
// no self-service way out, so the failure has to surface as an error.
async function issueCode(owner: CodeOwner, email: string, name: string): Promise<void> {
  if (!email.trim()) {
    throw new ServiceError(400, "This account has no email address. Use a text message code instead.");
  }
  await retireAll(owner);

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  const record = await emailVerificationRepository.create({
    ...owner,
    email: email.toLowerCase().trim(),
    codeHash,
    expiresAt,
  });

  const { subject, text, html } = buildEmail(code, name, owner);
  const delivered = await sendEmail(email, subject, text, html);

  if (!delivered) {
    // Retire the row we just wrote: leaving it live would let a later attempt
    // find an "active" code that nobody ever received.
    await emailVerificationRepository.markConsumed(record.id);
    logger.error(`[STAFF OTP] Delivery failed for ${ownerLabel(owner)} <${email}>`);
    throw new ServiceError(
      503,
      "userId" in owner
        ? "We couldn't email your verification code right now. Please try again shortly, or contact your system administrator."
        : "We couldn't email your verification code right now. Please try again shortly, or use a text message code."
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
  await issueCode({ userId }, email, name);
}

// Same verification shape as the customer verifiers, so the two behave
// identically from a caller's point of view.
export async function verifyLoginOtp(userId: number, code: string): Promise<void> {
  await verifyCode({ userId }, code);
}

export async function verifyCustomerLoginOtp(customerId: number, code: string): Promise<void> {
  await verifyCode({ customerId }, code);
}

async function verifyCode(owner: CodeOwner, code: string): Promise<void> {
  const record = await findLatestActive(owner);
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
  await resendCode({ userId }, email, name);
}

export async function resendCustomerLoginOtp(customerId: number, email: string, name: string): Promise<void> {
  await resendCode({ customerId }, email, name);
}

async function resendCode(owner: CodeOwner, email: string, name: string): Promise<void> {
  const existing = await findLatestActive(owner);
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
  await issueCode(owner, email, name);
}

export const STAFF_OTP_RESEND_COOLDOWN_SECONDS = RESEND_COOLDOWN_SECONDS;
