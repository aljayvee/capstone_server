import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger.js";

// Adapter over nodemailer — matches this project's rule to wrap third-party
// SDKs behind one module (same role as loadGoogleMaps.ts on the web side).
// SMTP credentials are optional at the process level (unlike JWT_SECRET,
// which fails the server fast) — a missing/incomplete config means sending
// fails soft (logged once, caller unaffected) rather than crashing the
// server. Registration must still succeed even before real SMTP credentials
// are supplied in server/.env.
let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    logger.error("Email sending disabled: SMTP_HOST/SMTP_USER/SMTP_PASS not set in server/.env");
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT ? Number(SMTP_PORT) : 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

// Returns whether the message actually went out. Callers that treat mail as
// best-effort keep ignoring the result (`void sendEmail(...)`); the staff
// login OTP is the one caller that must know, because a silently-dropped code
// locks a person out of the system with no way to recover on their own.
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  const client = getTransporter();
  if (!client) return false;

  try {
    await client.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html: html || undefined,
    });
    return true;
  } catch (err) {
    logger.error("Failed to send email:", err);
    return false;
  }
}

// True when SMTP is configured well enough to attempt a send. Used at startup
// to surface a missing config as a warning rather than as a mystery lockout on
// the first staff login.
export function isEmailConfigured(): boolean {
  return getTransporter() !== null;
}
