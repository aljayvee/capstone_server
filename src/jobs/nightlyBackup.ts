import cron from "node-cron";
import { sysAdminBackupService } from "../services/sysAdminBackupService.js";
import { sysAdminAlertService } from "../services/sysAdminAlertService.js";
import { logger } from "../lib/logger.js";
import { offsiteBackupService } from "../services/offsiteBackupService.js";
import { backupRestoreCheckService } from "../services/backupRestoreCheckService.js";

/**
 * Schedules automated nightly compressed database backups at 02:00 AM Asia/Manila.
 *
 * Until 2026-11-15 this was "0 18 * * *" read as UTC, but the server runs with
 * TZ=Asia/Manila, so it fired at 6 PM Manila, in the dinner rush. The zone is
 * now explicit so the hour no longer depends on the process environment.
 */
export function scheduleNightlyBackupJob() {
  cron.schedule("0 2 * * *", async () => {
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
  }, { timezone: "Asia/Manila" });

  // Monthly restore test, 03:00 on the 1st (after the 02:00 backup and its upload).
  cron.schedule("0 3 1 * *", () => {
    void backupRestoreCheckService.run("SCHEDULED");
  }, { timezone: "Asia/Manila" });

  // Off-site freshness, hourly: no verified copy in 26 hours means last night's
  // upload failed or never ran.
  cron.schedule("17 * * * *", () => {
    void offsiteBackupService.checkFreshness();
  }, { timezone: "Asia/Manila" });
}
