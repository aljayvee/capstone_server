import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { emailVerificationRepository } from "../repositories/emailVerificationRepository.js";
import { customerRepository } from "../repositories/customerRepository.js";
import { sendEmail } from "../lib/mailer.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "./ServiceError.js";
import { evaluateResend, streakSince } from "./otpCooldownPolicy.js";

const CODE_LENGTH = 6;
const CODE_EXPIRY_MINUTES = 15;
const MAX_ATTEMPTS = 5;

function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(CODE_LENGTH, "0");
}

// codeHash is bcrypt-hashed like passwordHash — never store the raw code —
// so a database read alone can't be used to impersonate verification.
async function issueCode(customerId: number | null, email: string): Promise<void> {
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  await emailVerificationRepository.create({ customerId: customerId || null, email: email.toLowerCase().trim(), codeHash, expiresAt });

  const textMessage = `Your Sugo On-the-Go verification code is: ${code}\n\nThis code expires in ${CODE_EXPIRY_MINUTES} minutes.\nIf you did not request this code, please ignore this email.`;

  const htmlMessage = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify your Sugo On-the-Go Account</title>
    </head>
    <body style="margin: 0; padding: 24px; background-color: #F8F9FA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
      <div style="max-width: 480px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; padding: 32px; border: 1px solid #E5E7EB; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-block; background-color: #F62459; color: #FFFFFF; font-weight: bold; font-size: 18px; padding: 8px 18px; border-radius: 9999px; letter-spacing: 1px;">
            SUGO EXPRESS
          </div>
          <h2 style="color: #111827; margin-top: 16px; margin-bottom: 8px; font-size: 22px;">Account Verification</h2>
          <p style="color: #6B7280; font-size: 14px; margin: 0;">Use the 6-digit code below to complete your registration.</p>
        </div>

        <div style="background-color: #FFEEF3; border: 1.5px dashed #F62459; border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: 800; color: #F62459; letter-spacing: 10px; font-family: monospace;">${code}</span>
        </div>

        <p style="color: #4B5563; font-size: 13px; text-align: center; margin-bottom: 24px;">
          ⏱️ This code will expire in <strong>${CODE_EXPIRY_MINUTES} minutes</strong>.
        </p>

        <div style="border-top: 1px solid #F3F4F6; padding-top: 18px; text-align: center;">
          <p style="color: #9CA3AF; font-size: 12px; margin: 0;">
            If you did not attempt to sign up for Sugo On-the-Go, please disregard this message.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  // Fire-and-forget: an email failure must never fail the caller's request —
  // same contract as sendPushNotification.
  void sendEmail(
    email,
    "Your Sugo On-the-Go Verification Code",
    textMessage,
    htmlMessage
  );
}

/**
 * The password-reset twin of issueCode. It exists separately rather than taking
 * a flag because the EMAIL is the security control here: a message that says
 * "complete your registration" while someone is actually resetting a password
 * is exactly the wording that trains people to ignore the one alert that would
 * tell them their account is under attack.
 */
export async function sendPasswordResetCode(customerId: number, email: string): Promise<void> {
  const cleanEmail = email.toLowerCase().trim();
  // Retire any code still outstanding for this account first.
  await emailVerificationRepository.consumeAllForCustomer(customerId);

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  await emailVerificationRepository.create({ customerId, email: cleanEmail, codeHash, expiresAt });

  const textMessage = `Your Sugo On-the-Go password reset code is: ${code}

This code expires in ${CODE_EXPIRY_MINUTES} minutes.

If you did NOT ask to reset your password, someone else may have entered your username. Your password has not changed and no action is needed — but do not share this code with anyone.`;

  const htmlMessage = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Reset your Sugo On-the-Go password</title>
    </head>
    <body style="margin: 0; padding: 24px; background-color: #F8F9FA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
      <div style="max-width: 480px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; padding: 32px; border: 1px solid #E5E7EB; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-block; background-color: #F62459; color: #FFFFFF; font-weight: bold; font-size: 18px; padding: 8px 18px; border-radius: 9999px; letter-spacing: 1px;">
            SUGO EXPRESS
          </div>
          <h2 style="color: #111827; margin-top: 16px; margin-bottom: 8px; font-size: 22px;">Password Reset</h2>
          <p style="color: #6B7280; font-size: 14px; margin: 0;">Use the 6-digit code below to set a new password.</p>
        </div>

        <div style="background-color: #FFEEF3; border: 1.5px dashed #F62459; border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: 800; color: #F62459; letter-spacing: 10px; font-family: monospace;">${code}</span>
        </div>

        <p style="color: #4B5563; font-size: 13px; text-align: center; margin-bottom: 24px;">
          ⏱️ This code will expire in <strong>${CODE_EXPIRY_MINUTES} minutes</strong>.
        </p>

        <div style="border-top: 1px solid #F3F4F6; padding-top: 18px;">
          <p style="color: #6B7280; font-size: 12px; margin: 0; line-height: 18px;">
            <strong style="color: #B91C1C;">Did not request this?</strong> Someone may have entered your username
            on the sign-in screen. Your password has <strong>not</strong> changed and you do not need to do anything.
            Never share this code with anyone — Sugo staff will never ask you for it.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  void sendEmail(cleanEmail, "Your Sugo On-the-Go Password Reset Code", textMessage, htmlMessage);
}

export async function sendVerificationCode(customerId: number, email: string): Promise<void> {
  await issueCode(customerId, email);
}

// Resolves with the seconds the caller should wait before offering a resend,
// so the client's countdown is the server's schedule rather than a guess.
export async function sendRegistrationOtp(email: string): Promise<number> {
  const cleanEmail = email.toLowerCase().trim();
  const existing = await customerRepository.findByUsernameOrEmail("", cleanEmail);
  if (existing) {
    throw new ServiceError(400, "An account with this email address already exists.");
  }

  // A code issued moments ago is still in the inbox. Re-issuing here does not
  // visibly retire it, but verifyRegistrationOtp only ever checks the NEWEST
  // code for an address — so the one the person is reading would silently stop
  // being accepted. Resolve quietly instead: the caller's contract is "a code is
  // on its way", and one is.
  const since = streakSince();
  const [issueCount, lastCode] = await Promise.all([
    emailVerificationRepository.countRecentForEmail(cleanEmail, since),
    emailVerificationRepository.findLatestForEmail(cleanEmail),
  ]);

  const lastIssuedAt = lastCode && lastCode.createdAt >= since ? lastCode.createdAt : null;
  const { allowed, retryAfterSeconds } = evaluateResend(lastIssuedAt, issueCount);

  if (!allowed) {
    logger.info(
      `[REGISTRATION OTP] Holding ${cleanEmail} — ${issueCount} code(s) already sent this hour, ${retryAfterSeconds}s left`
    );
    return retryAfterSeconds;
  }

  // Exactly one live code per address, so a stale row can never be the one
  // findLatestActiveForEmail happens to return.
  await emailVerificationRepository.consumeAllForEmail(cleanEmail);
  await issueCode(null, cleanEmail);
  return retryAfterSeconds;
}

export async function verifyRegistrationOtp(email: string, code: string): Promise<void> {
  const cleanEmail = email.toLowerCase().trim();
  const record = await emailVerificationRepository.findLatestActiveForEmail(cleanEmail);
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

// ---------------------------------------------------------------------------
// PHONE OTP — NOT WIRED UP. Retained for a future SMS integration.
//
// There is no SMS gateway in this project: no provider package in
// package.json, no credentials in server/.env. The function below generates a
// real code and stores it correctly, then writes it to the SERVER CONSOLE
// instead of sending it. The log line reads "sent", which is why this looks
// functional from the outside — it is not. It returns success, so any caller
// will happily tell a user a text message is on the way.
//
// The CustomerApp no longer calls these: registration is email-only (see
// RegisterScreen.tsx's verificationChannel). The routes stay mounted so this
// keeps compiling and stays ready to finish.
//
// To make it real: add an adapter alongside lib/mailer.ts (Semaphore/Twilio for
// a server-sent code, or move to Firebase Phone Auth and verify the resulting
// ID token instead), then replace the logger.info below with that call and
// treat a failed send as an error the way staffVerificationService does.
// Everything else here — generation, hashing, expiry, attempt limits,
// verification — is already correct and needs no changes.
// ---------------------------------------------------------------------------
export async function sendRegistrationPhoneOtp(phone: string): Promise<void> {
  const cleanPhone = phone.trim();
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  await emailVerificationRepository.create({ customerId: null, phone: cleanPhone, codeHash, expiresAt });
  // NOT SENT — printed locally. See the block comment above before relying on this.
  logger.warn(`[PHONE OTP STUB — NO SMS SENT] Code for ${cleanPhone} is ${code} (read it from this log)`);
}

export async function verifyRegistrationPhoneOtp(phone: string, code: string): Promise<void> {
  const cleanPhone = phone.trim();
  const record = await emailVerificationRepository.findLatestActiveForPhone(cleanPhone);
  if (!record) {
    throw new ServiceError(400, "No pending verification code found for this phone number. Please request a new one.");
  }
  if (record.expiresAt < new Date()) {
    throw new ServiceError(400, "This verification code has expired. Please request a new one.");
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

export async function resendVerificationCode(customerId: number): Promise<void> {
  const customer = await customerRepository.findById(customerId);
  if (!customer) {
    throw new ServiceError(404, "Account not found");
  }
  if (customer.emailVerified) {
    throw new ServiceError(400, "This account is already verified.");
  }
  await issueCode(customerId, customer.email);
}

export async function verifyCode(customerId: number, code: string): Promise<void> {
  const customer = await customerRepository.findById(customerId);
  if (!customer) {
    throw new ServiceError(404, "Account not found");
  }
  if (customer.emailVerified) {
    return; // Idempotent — already verified, nothing to do.
  }

  const record = await emailVerificationRepository.findLatestActiveForCustomer(customerId);
  if (!record) {
    throw new ServiceError(400, "No pending verification code. Please request a new one.");
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
  await customerRepository.markEmailVerified(customerId);
}
