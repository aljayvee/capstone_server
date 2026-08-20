import cron from "node-cron";
import { tokenBlocklistRepository } from "../repositories/tokenBlocklistRepository.js";
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
  });
}
