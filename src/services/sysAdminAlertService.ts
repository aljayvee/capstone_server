/**
 * sysAdminAlertService.ts
 *
 * Automated Telegram emergency alert service and audit logger.
 * Dispatches critical security, crash, and infrastructure notifications.
 */

import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export type AlertType =
  | "CRITICAL_INTRUSION"
  | "SERVICE_RESTART"
  | "DB_DISCONNECT"
  | "DISK_WARNING"
  | "BACKEND_CRASH"
  | "SERVICE_RECOVERED"
  | "BACKUP_FAILURE"
  | "TEST_ALERT";

export interface AlertPayload {
  alertType: AlertType;
  severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  message: string;
  metadata?: Record<string, any>;
  /**
   * Alerts sharing a key reach Telegram at most once per REPEAT_WINDOW_MS; the
   * rest are recorded as SUPPRESSED (reason "repeat_limit") and counted in the
   * next one that goes out. Default: type + title, so only identical alerts
   * collapse. Pass a wider key when the title varies (one per banned IP).
   */
  repeatKey?: string;
  /** State changes (down, recovered) and manual tests must never be held back. */
  bypassRepeatLimit?: boolean;
}

export const REPEAT_WINDOW_MS = 30 * 60 * 1000;
const REPEAT_KEYS_MAX = 500;

/** In memory: the API runs as one process, and a restart forgetting it only costs one extra message. */
const recentlySent = new Map<string, { at: number; heldBack: number }>();

/** Test hook: the window is module state. */
export function resetAlertRepeatLimit(): void {
  recentlySent.clear();
}

function pruneRepeatKeys(now: number): void {
  if (recentlySent.size <= REPEAT_KEYS_MAX) return;
  for (const [key, entry] of recentlySent) {
    if (now - entry.at >= REPEAT_WINDOW_MS) recentlySent.delete(key);
  }
}

export const sysAdminAlertService = {
  /**
   * Checks if Telegram alerts are configured via environment variables.
   */
  isConfigured(): boolean {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();
    return Boolean(token && chatId);
  },

  /**
   * Returns current alert integration status and recent history.
   */
  async getAlertStatus(): Promise<{
    isConfigured: boolean;
    maskedChatId: string | null;
    totalAlertsSent: number;
    recentAlerts: any[];
  }> {
    const configured = this.isConfigured();
    const rawChatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim() || "";
    let maskedChatId: string | null = null;

    if (rawChatId) {
      maskedChatId =
        rawChatId.length > 4
          ? `${rawChatId.slice(0, 2)}***${rawChatId.slice(-2)}`
          : "***";
    }

    const [totalAlertsSent, recentAlerts] = await Promise.all([
      prisma.sysAdminAlert.count({ where: { status: "SENT" } }),
      prisma.sysAdminAlert.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    return {
      isConfigured: configured,
      maskedChatId,
      totalAlertsSent,
      recentAlerts,
    };
  },

  /**
   * Sends an emergency notification via Telegram and logs to database.
   */
  async sendTelegramAlert(payload: AlertPayload): Promise<boolean> {
    // Not `this`: callers sometimes pass the method around detached.
    return (await sysAdminAlertService.sendAlert(payload)).sent;
  },

  /**
   * sendTelegramAlert plus the id of the recorded row, so an incident can link
   * it. alertId is null when the row could not be written (database down).
   */
  async sendAlert(payload: AlertPayload): Promise<{ sent: boolean; alertId: number | null }> {
    const {
      alertType,
      severity = "HIGH",
      title,
      metadata = {},
    } = payload;
    let { message } = payload;

    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();

    const repeatKey = payload.repeatKey ?? `${alertType}:${title}`;
    const now = Date.now();
    const recent = recentlySent.get(repeatKey);

    // Held back: still recorded, so the SysAdmin history stays complete.
    if (
      botToken &&
      chatId &&
      !payload.bypassRepeatLimit &&
      recent &&
      now - recent.at < REPEAT_WINDOW_MS
    ) {
      recent.heldBack += 1;
      logger.info(
        `[AlertService] Telegram alert held back (repeat limit, ${recent.heldBack} since last sent): [${alertType}] ${title}`
      );
      const heldBackId = await recordAlert({
        alertType,
        severity,
        title,
        message,
        status: "SUPPRESSED",
        metadata: { ...metadata, suppressedReason: "repeat_limit" },
      });
      return { sent: false, alertId: heldBackId };
    }

    if (recent && recent.heldBack > 0) {
      const since = new Date(recent.at).toLocaleTimeString("en-US", {
        timeZone: "Asia/Manila",
        timeStyle: "short",
      });
      message +=
        `\n\n${recent.heldBack} similar alert${recent.heldBack === 1 ? " was" : "s were"} ` +
        `held back since ${since} PHT. See SysAdmin, DevOps, Telegram Alerts.`;
    }

    const timestamp = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Manila",
      dateStyle: "medium",
      timeStyle: "medium",
    });

    let severityEmoji = "⚠️";
    if (severity === "CRITICAL") severityEmoji = "🚨";
    if (severity === "MEDIUM") severityEmoji = "🔔";
    if (severity === "LOW") severityEmoji = "ℹ️";

    const formattedText =
      `<b>${severityEmoji} [SUGO IT ALERT - ${severity}]</b>\n` +
      `<b>Type:</b> <code>${alertType}</code>\n` +
      `<b>Title:</b> ${escapeHtml(title)}\n` +
      `<b>Time:</b> ${timestamp} PHT\n` +
      `<b>Message:</b>\n${escapeHtml(message)}\n` +
      (Object.keys(metadata).length > 0
        ? `\n<b>Details:</b>\n<pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre>`
        : "");

    let status = "SENT";
    let recordedMetadata: Record<string, any> = metadata;

    if (!botToken || !chatId) {
      logger.warn(
        `[AlertService] Telegram alert suppressed (not configured): [${alertType}] ${title}`
      );
      status = "SUPPRESSED";
      recordedMetadata = { ...metadata, suppressedReason: "not_configured" };
    } else {
      try {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: formattedText,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          logger.error(`[AlertService] Telegram API error (${res.status}):`, errBody);
          status = "FAILED";
        }
      } catch (err) {
        logger.error("[AlertService] Network error sending Telegram alert:", err);
        status = "FAILED";
      }
    }

    // A failed send leaves the window closed, so the next alert tries again.
    if (status === "SENT") {
      recentlySent.set(repeatKey, { at: now, heldBack: 0 });
      pruneRepeatKeys(now);
    }

    // Persist alert audit entry
    const alertId = await recordAlert({ alertType, severity, title, message, status, metadata: recordedMetadata });

    return { sent: status === "SENT", alertId };
  },

  /**
   * Dispatches a manual test alert.
   */
  async sendTestAlert(adminUsername: string): Promise<{ success: boolean; message: string }> {
    if (!this.isConfigured()) {
      return {
        success: false,
        message: "Telegram Bot Token or Alert Chat ID is missing in server .env configuration.",
      };
    }

    const sent = await this.sendTelegramAlert({
      alertType: "TEST_ALERT",
      severity: "LOW",
      title: "Diagnostic IT Test Alert",
      message: `Test notification triggered by administrator @${adminUsername} via SysAdmin Console.`,
      bypassRepeatLimit: true,
      metadata: {
        triggeredBy: adminUsername,
        vpsHost: "Contabo VPS (109.123.239.182)",
      },
    });

    if (sent) {
      return { success: true, message: "Test alert dispatched successfully to Telegram." };
    } else {
      return { success: false, message: "Failed to dispatch test alert. Check server logs." };
    }
  },
};

/**
 * Never throws: an alert about the database being down must not fail because
 * the database is down. Telegram has already been tried by the time this runs.
 */
async function recordAlert(row: {
  alertType: AlertType;
  severity: string;
  title: string;
  message: string;
  status: string;
  metadata: Record<string, any>;
}): Promise<number | null> {
  try {
    const created = await prisma.sysAdminAlert.create({
      data: { ...row, channel: "TELEGRAM" },
      select: { id: true },
    });
    return created.id;
  } catch (dbErr) {
    logger.error("[AlertService] Failed to record alert audit record in DB:", dbErr);
    return null;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
