import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { checkRiderStatuses, resetShiftsAtMidnight } from "../services/riderStatusWatchService.js";
import { onLiveLinkChange } from "../lib/riderLiveLink.js";

/**
 * Every 20 seconds: turn rider status changes into events and connectivity
 * alerts. Twenty seconds is inside the fastest signal-lost window (25 s for a
 * rider on an errand), so a dispatcher hears about a lost rider at about the
 * moment the server itself decides it.
 *
 * Every day at 12:00 AM Manila time: end every shift.
 */
export function scheduleRiderShiftJobs() {
  let running = false;
  let again = false;
  const runCheck = async () => {
    // A slow database must not stack passes on top of each other. A request
    // that arrives mid-pass is not dropped, it runs once the pass finishes,
    // because it may be the very change the pass began too early to see.
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await checkRiderStatuses();
      } while (again);
    } catch (error) {
      logger.error("Rider status watch failed:", error);
    } finally {
      running = false;
    }
  };

  // The fallback pass, for everything the heartbeat cannot see: beacons going
  // stale for riders whose app is closed or predates the heartbeat.
  cron.schedule("*/20 * * * * *", runCheck);

  // The fast path. A rider's one-second heartbeat stopping (or resuming) runs
  // a pass straight away, so dispatch, the owner and the customer hear about it
  // within about three seconds instead of on the next twenty-second tick.
  // Coalesced briefly, so several riders dropping together cost one pass.
  let pending: ReturnType<typeof setTimeout> | null = null;
  onLiveLinkChange(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      void runCheck();
    }, 150);
  });

  cron.schedule(
    "0 0 * * *",
    async () => {
      try {
        await resetShiftsAtMidnight();
      } catch (error) {
        logger.error("Midnight shift reset failed:", error);
      }
    },
    { timezone: "Asia/Manila" }
  );
}
