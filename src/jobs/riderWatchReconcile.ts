import cron from "node-cron";
import { reconcileRiderWatchers } from "../lib/riderWatch.js";
import { logger } from "../lib/logger.js";

// Every minute, and once at start: who may read which rider's live position
// (lib/riderWatch.ts). Errand changes trigger it sooner; this catches the ones
// that finish by a path that publishes nothing, and a restart.
export function scheduleRiderWatchReconcileJob() {
  const run = async () => {
    try {
      await reconcileRiderWatchers();
    } catch (error) {
      logger.error("Failed to reconcile rider_watchers:", error);
    }
  };
  void run();
  cron.schedule("* * * * *", run);
}
