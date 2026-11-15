import cron from "node-cron";
import { logRetention } from "../services/logRetentionService.js";
import { logger } from "../lib/logger.js";

// 03:30 Manila: after the 02:00 nightly backup has had time to upload to R2.
// The service itself refuses to remove anything unless a backup from the last
// 24 hours reached off-site storage.
export function scheduleLogRetentionJob() {
  cron.schedule(
    "30 3 * * *",
    async () => {
      try {
        await logRetention.run("SCHEDULED");
      } catch (err) {
        logger.error("[LogRetention] Scheduled cleanup did not run:", err);
      }
    },
    { timezone: "Asia/Manila" },
  );
}
