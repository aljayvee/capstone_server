import cron from "node-cron";
import * as riderPresenceService from "../services/riderPresenceService.js";
import { logger } from "../lib/logger.js";

// Every 2 minutes: archive one ONLINE/OFFLINE row per rider (Phase 3 "log every
// 2 mins for archiving"), and close any login session abandoned by a rider who
// force-quit without logging out. Same tick does both since both need the same
// "who's actually online right now" read of the presence store.
export function scheduleRiderStatusSnapshotJob() {
  cron.schedule("*/2 * * * *", async () => {
    try {
      await riderPresenceService.recordStatusSnapshot();
    } catch (error) {
      logger.error("Failed to record rider status snapshot:", error);
    }
    try {
      await riderPresenceService.sweepAbandonedLoginSessions();
    } catch (error) {
      logger.error("Failed to sweep abandoned rider login sessions:", error);
    }
  });
}
