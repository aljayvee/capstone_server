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
  | "TEST_ALERT";

export interface AlertPayload {
  alertType: AlertType;
  severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  message: string;
  metadata?: Record<string, any>;
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
    const {
      alertType,
      severity = "HIGH",
      title,
      message,
      metadata = {},
    } = payload;

    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();

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

    if (!botToken || !chatId) {
      logger.warn(
        `[AlertService] Telegram alert suppressed (not configured): [${alertType}] ${title}`
      );
      status = "SUPPRESSED";
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

    // Persist alert audit entry
    try {
      await prisma.sysAdminAlert.create({
        data: {
          alertType,
          severity,
          title,
          message,
          channel: "TELEGRAM",
          status,
          metadata,
        },
      });
    } catch (dbErr) {
      logger.error("[AlertService] Failed to record alert audit record in DB:", dbErr);
    }

    return status === "SENT";
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
