import cron from "node-cron";
import { sysAdminBackupService } from "../services/sysAdminBackupService.js";
import { sysAdminAlertService } from "../services/sysAdminAlertService.js";
import { logger } from "../lib/logger.js";

/**
 * Schedules automated nightly compressed database backups at 02:00 AM Asia/Manila (18:00 UTC).
 */
export function scheduleNightlyBackupJob() {
  // 02:00 AM Asia/Manila corresponds to 18:00 UTC (Manila is UTC+8)
  cron.schedule("0 18 * * *", async () => {
    logger.info("[NightlyBackup] Starting automated 02:00 AM database backup job...");

    try {
      const backup = await sysAdminBackupService.createDatabaseBackup("AUTOMATED");
      logger.info(`[NightlyBackup] Automated backup completed: ${backup.fileName} (${backup.fileSizeFormatted})`);

      // Telegram notification for successful nightly backup
      sysAdminAlertService
        .sendTelegramAlert({
          alertType: "TEST_ALERT",
          severity: "LOW",
          title: "Nightly Database Backup Successful",
          message: `Automated compressed snapshot generated: ${backup.fileName} (${backup.fileSizeFormatted}). Retained for 7 days.`,
          metadata: {
            fileName: backup.fileName,
            fileSize: backup.fileSizeFormatted,
            timestamp: new Date().toISOString(),
          },
        })
        .catch(() => {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[NightlyBackup] Automated database backup failed:", err);

      sysAdminAlertService
        .sendTelegramAlert({
          alertType: "DB_DISCONNECT",
          severity: "HIGH",
          title: "Nightly Database Backup FAILED",
          message: `The automated 02:00 AM database backup snapshot encountered an error: ${msg}`,
          metadata: { error: msg },
        })
        .catch(() => {});
    }
  });
}
