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

export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const client = getTransporter();
  if (!client) return;

  try {
    await client.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html: html || undefined,
    });
  } catch (err) {
    logger.error("Failed to send email:", err);
  }
}
