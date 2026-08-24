import { sendEmail } from "../lib/mailer.js";
import { renderDetailRows, renderEmailShell } from "../lib/emailTemplates.js";
import { logger } from "../lib/logger.js";
import { roleLabel } from "../lib/roleLabels.js";

// "Someone just signed in to your account" — sent after every successful staff
// sign-in, which is what makes an unauthorised one visible to its owner.
//
// This must never block or fail a login. Everything below is synchronous except
// sendEmail, which swallows its own errors, and the whole body is try/caught.
// The function returns void rather than a promise precisely so there is nothing
// a caller could accidentally await.

export type LoginChannel = "WEB_PORTAL" | "RIDER_APP";

export interface LoginContext {
  ipAddress: string | null;
  userAgent: string | null;
  deviceHint: string | null;
  channel: LoginChannel;
}

export interface LoginAlertUser {
  id: number;
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  role: string;
}

// Order is load-bearing: Edge's user-agent contains "Chrome/", and Chrome's
// contains "Safari/". Checking the most specific first is the whole trick.
function detectBrowser(ua: string): string {
  if (/Edg\//.test(ua)) return "Microsoft Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua)) return "Safari";
  if (/okhttp|CFNetwork|Expo|ReactNative/i.test(ua)) return "Sugo Rider App";
  return "Unknown app";
}

function detectOs(ua: string): string {
  const android = ua.match(/Android (\d+)/);
  if (android) return `Android ${android[1]}`;
  if (/Windows NT 10\.0/.test(ua)) return "Windows 10/11";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown OS";
}

export function describeDevice(ctx: LoginContext): string {
  if (ctx.channel === "RIDER_APP") {
    return ctx.deviceHint ? `Sugo Rider App (${ctx.deviceHint})` : "Sugo Rider App";
  }
  const ua = ctx.userAgent || "";
  if (!ua) return "Unknown device";
  return `${detectBrowser(ua)} on ${detectOs(ua)}`;
}

// Node 20 ships full ICU, so Asia/Manila resolves. The literal " (PHT)" is
// appended unconditionally: on a hypothetical small-ICU build that silently
// falls back to UTC, the result is visibly wrong rather than quietly wrong.
const MANILA_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  dateStyle: "full",
  timeStyle: "short",
});

function formatManilaTime(at: Date): string {
  return `${MANILA_FORMATTER.format(at)} (PHT)`;
}

export function sendLoginAlert(user: LoginAlertUser, ctx: LoginContext): void {
  try {
    const email = (user.email || "").trim();
    if (!email) return;

    const at = new Date();
    const fullName = `${user.firstName} ${user.lastName}`.trim() || user.username;
    const device = describeDevice(ctx);
    const when = formatManilaTime(at);
    const ip = ctx.ipAddress || "Unknown";
    const surface = ctx.channel === "RIDER_APP" ? "Sugo Rider App" : "Sugo Express Web Portal";

    const text =
      `Hi ${fullName},\n\n` +
      `Your Sugo Express account was just used to sign in.\n\n` +
      `Account:  ${user.username} (${roleLabel(user.role)})\n` +
      `Signed in to: ${surface}\n` +
      `Device:   ${device}\n` +
      `Time:     ${when}\n` +
      `IP address: ${ip}\n\n` +
      `Timestamp (ISO 8601): ${at.toISOString()}\n\n` +
      `If this was you, no action is needed. If it was not, contact your system administrator immediately.`;

    // Every value below is escaped by renderDetailRows — the user-agent this is
    // derived from is fully caller-controlled text going into an HTML document.
    const html = renderEmailShell({
      title: "New Sign-In Detected",
      subtitle: "Your Sugo Express account was just used to sign in.",
      bodyHtml: renderDetailRows([
        { label: "Name", value: fullName },
        { label: "Account", value: `${user.username} (${roleLabel(user.role)})` },
        { label: "Signed in to", value: surface },
        { label: "Device", value: device },
        { label: "Time", value: when },
        { label: "IP address", value: ip },
      ]),
      footerNote:
        "If this was you, no action is needed. If you do not recognise this sign-in, contact your system administrator immediately.",
    });

    void sendEmail(email, "New sign-in to your Sugo Express account", text, html);
  } catch (err) {
    // A malformed user-agent must never turn a successful login into a 500.
    logger.error("Failed to build login alert email:", err);
  }
}
