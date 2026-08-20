import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { relearnDwellTimes } from "../services/dwellLearningService.js";

// Nightly at 03:15. Dwell percentiles change slowly — they describe how long a
// kind of shop takes — so there is nothing to gain from recomputing them more
// often, and doing it off-peak keeps the read off the working day.
export function scheduleDwellLearningJob() {
  cron.schedule("15 3 * * *", async () => {
    try {
      await relearnDwellTimes();
    } catch (error) {
      logger.error("Dwell learning job failed:", error);
    }
  });
}
