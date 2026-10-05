import cron from "node-cron";
import {
  ensureCategoryModelsCurrent,
  triggerCategoryAutoLearning,
} from "../services/categoryRetrainingService.js";

// Nightly at 03:45, after dwell learning (03:15). Each day's pins and items are
// new labelled rows for the category models; a category edit already retrains
// at once, and this catches everything else, one retrain a day, off-peak.
//
// Plus a staleness check two minutes after boot and every half hour: a
// container rebuilt or restored from an old image is retrained as soon as its
// classes stop matching the catalogue (categoryRetrainingService.staleModelReasons).
export function scheduleCategoryRetrainingJob() {
  cron.schedule("45 3 * * *", () => {
    triggerCategoryAutoLearning({ reason: "nightly" });
  });
  setTimeout(() => void ensureCategoryModelsCurrent(), 2 * 60 * 1000).unref?.();
  cron.schedule("*/30 * * * *", () => {
    void ensureCategoryModelsCurrent();
  });
}
