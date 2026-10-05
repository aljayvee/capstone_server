import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { sendEmail } from "../lib/mailer.js";
import { renderDetailRows, renderEmailShell, renderSecurityAdvisory } from "../lib/emailTemplates.js";
import { logger } from "../lib/logger.js";
import { roleLabel } from "../lib/roleLabels.js";

// "Someone just signed in to your account" — sent after a staff member signs in
// from a new or unrecognized device/browser, alerting the owner to potential unauthorized access.
//
// Recognized devices (tracked in user_known_devices) update their lastSeenAt timestamp
// and skip sending redundant emails on subsequent logins.
//
// This must never block or fail a login. Callers fire it asynchronously via
// `void sendLoginAlert(...)`, and the whole body is try/caught.

export type LoginChannel = "WEB_PORTAL" | "RIDER_APP";

export interface LoginContext {
  ipAddress: string | null;
  userAgent: string | null;
  deviceHint: string | null;
  deviceId?: string | null;
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

/**
 * Resolves an effective unique device identifier.
 *
 * For web portal and mobile apps, `ctx.deviceId` is provided via `x-device-id`.
 * When missing or uninitialized (e.g. storage-restricted private mode or API scripts),
 * falls back to a deterministic hash of channel, device hint, and user-agent so repeated
 * sign-ins from the same browser don't repeatedly trigger security alerts.
 */
export function resolveEffectiveDeviceId(ctx: LoginContext): string | null {
  const rawId = ctx.deviceId?.trim();
  if (rawId && rawId !== "undefined" && rawId !== "null") {
    return rawId.slice(0, 80);
  }
  const clientIdentifier = [ctx.deviceHint?.trim(), ctx.userAgent?.trim()]
    .filter(Boolean)
    .join(":");
  if (clientIdentifier) {
    const hash = crypto
      .createHash("sha256")
      .update(`${ctx.channel}:${clientIdentifier}`)
      .digest("hex")
      .slice(0, 32);
    return `ua-${hash}`;
  }
  return null;
}

/**
 * Checks whether the incoming sign-in comes from a recognized device/browser.
 *
 * 1. If found in `user_known_devices`: updates `lastSeenAt` and returns `{ isNew: false }`.
 * 2. If not found, checks `user_sessions` for an existing session with the same `deviceId`
 *    (graceful migration for active users): backfills `user_known_devices` and returns `{ isNew: false }`.
 *    NOTE: Deliberately does NOT filter on `revokedAt: null` because `revokeSameDeviceSessions`
 *    marks earlier sessions on that device as revoked right before `sendLoginAlert` is called.
 * 3. If deviceId is a deterministic UA hash (storage-restricted client), checks `account_login_logs`
 *    for a prior successful login from the same browser/IP: backfills and returns `{ isNew: false }`.
 * 4. If unrecognized: registers the new device in `user_known_devices` and returns `{ isNew: true }`.
 */
export async function checkAndRegisterDevice(
  userId: number,
  ctx: LoginContext
): Promise<{ isNew: boolean }> {
  const deviceId = resolveEffectiveDeviceId(ctx);
  if (!deviceId) {
    return { isNew: true };
  }

  const now = new Date();
  const deviceInfo = describeDevice(ctx).slice(0, 120);
  const ua = ctx.userAgent?.slice(0, 300) ?? null;
  const ip = ctx.ipAddress?.slice(0, 64) ?? null;

  try {
    // 1. Check if device is already registered in user_known_devices
    const known = await prisma.userKnownDevice.findUnique({
      where: {
        userId_deviceId: {
          userId,
          deviceId,
        },
      },
    });

    if (known) {
      // Recognized device: update lastSeenAt safely without letting timestamp update failure trigger a false alert
      try {
        await prisma.userKnownDevice.update({
          where: { id: known.id },
          data: {
            lastSeenAt: now,
            deviceInfo,
            userAgent: ua,
            ipAddress: ip,
          },
        });
      } catch (updateErr) {
        logger.warn("[LoginNotification] Failed to update lastSeenAt for known device:", updateErr);
      }
      return { isNew: false };
    }

    // 2. Graceful backfill: Check if this user has an existing session on this device.
    // We intentionally omit `revokedAt: null` because `revokeSameDeviceSessions` marks
    // prior sessions as revoked immediately before `sendLoginAlert` is invoked.
    const priorSession = await prisma.userSession.findFirst({
      where: {
        subjectId: userId,
        subjectType: "USER",
        deviceId,
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    if (priorSession) {
      try {
        await prisma.userKnownDevice.create({
          data: {
            userId,
            deviceId,
            deviceInfo,
            userAgent: ua,
            ipAddress: ip,
            firstSeenAt: priorSession.createdAt,
            lastSeenAt: now,
          },
        });
      } catch (createErr: any) {
        if (createErr?.code !== "P2002") {
          logger.warn("[LoginNotification] Failed to backfill known device from prior session:", createErr);
        }
      }
      return { isNew: false };
    }

    // 3. Graceful backfill from account_login_logs:
    // If deviceId is a deterministic UA hash (storage-restricted client), check if this user
    // previously signed in successfully with this browser and IP.
    if (deviceId.startsWith("ua-") && ua) {
      const priorLoginLog = await prisma.accountLoginLog.findFirst({
        where: {
          userId,
          status: "SUCCESS",
          userAgent: ua,
          ...(ip ? { ipAddress: ip } : {}),
        },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });

      if (priorLoginLog) {
        try {
          await prisma.userKnownDevice.create({
            data: {
              userId,
              deviceId,
              deviceInfo,
              userAgent: ua,
              ipAddress: ip,
              firstSeenAt: priorLoginLog.createdAt,
              lastSeenAt: now,
            },
          });
        } catch (createErr: any) {
          if (createErr?.code !== "P2002") {
            logger.warn("[LoginNotification] Failed to backfill known device from account_login_logs:", createErr);
          }
        }
        return { isNew: false };
      }
    }

    // 4. Unrecognized / New device: register it in user_known_devices and return isNew = true
    await prisma.userKnownDevice.create({
      data: {
        userId,
        deviceId,
        deviceInfo,
        userAgent: ua,
        ipAddress: ip,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });

    return { isNew: true };
  } catch (err: any) {
    // Unique constraint violation (P2002) in concurrent login requests for the same device
    if (err?.code === "P2002") {
      return { isNew: false };
    }
    logger.error("[LoginNotification] Failed to evaluate or register device:", err);
    return { isNew: true };
  }
}

export async function sendLoginAlert(user: LoginAlertUser, ctx: LoginContext): Promise<void> {
  try {
    const email = (user.email || "").trim();
    if (!email) return;

    // Check device recognition: suppress alert if device is already recognized
    const { isNew } = await checkAndRegisterDevice(user.id, ctx);
    if (!isNew) {
      logger.info(
        `[LoginNotification] Suppressed sign-in alert for user ${user.username} (recognized device: ${describeDevice(ctx)})`
      );
      return;
    }

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

    const bodyHtml = `
      ${renderDetailRows([
        { label: "Name", value: fullName },
        { label: "Account", value: `${user.username} (${roleLabel(user.role)})` },
        { label: "Signed in to", value: surface },
        { label: "Device", value: device },
        { label: "Time", value: when },
        { label: "IP address", value: ip },
      ])}
      ${renderSecurityAdvisory(
        "Security Alert",
        "If you do not recognize this activity, your credentials may be compromised. Please notify your system administrator immediately to lock and secure your account."
      )}
    `;

    const html = renderEmailShell({
      title: "New Sign-In Detected",
      subtitle: "Your Sugo Express account was just used to sign in.",
      bodyHtml,
      footerNote:
        "If this was you, no action is needed. If you do not recognise this sign-in, contact your system administrator immediately.",
      categoryBadge: "SECURITY AUDIT",
      preheader: `New sign-in to your Sugo Express account from ${device}.`,
    });

    await sendEmail(email, "New sign-in to your Sugo Express account", text, html);
  } catch (err) {
    // A database or mail error must never turn a successful login into a 500.
    logger.error("Failed to build or send login alert email:", err);
  }
}
