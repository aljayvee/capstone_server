import cron from "node-cron";
import { tokenBlocklistRepository } from "../repositories/tokenBlocklistRepository.js";
import * as sessionService from "../services/sessionService.js";
import { logger } from "../lib/logger.js";

// Hourly sweep of expired TokenBlocklist rows — nothing else ever deletes from
// that table, so without this it grows unbounded (see AGENTS.md server section 5).
export function schedulePruneBlocklistJob() {
  cron.schedule("0 * * * *", async () => {
    try {
      const { count } = await tokenBlocklistRepository.deleteExpired();
      if (count > 0) {
        logger.info(`Pruned ${count} expired token(s) from TokenBlocklist.`);
      }
    } catch (error) {
      logger.error("Failed to prune expired TokenBlocklist rows:", error);
    }

    // Same problem, same sweep: `user_sessions` gains a row per sign-in and
    // nothing else deletes from it. Kept in this job rather than a second cron
    // so there is one place that owns auth-table housekeeping.
    try {
      const removed = await sessionService.deleteExpiredSessions();
      if (removed > 0) {
        logger.info(`Pruned ${removed} expired or long-revoked session(s).`);
      }
    } catch (error) {
      logger.error("Failed to prune expired user_sessions rows:", error);
    }
  });
}
