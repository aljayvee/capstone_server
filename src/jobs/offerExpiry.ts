import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { expireStaleOffers } from "../services/errandService.js";

/**
 * Every 15 seconds: take back offers nobody answered (errandService.OFFER_EXPIRY_MS).
 *
 * The rider app declines an expired offer itself when it is open. This is for
 * when it is not, which used to leave the errand ASSIGNED to that rider forever
 * (2026-10-09). Fifteen seconds keeps the worst case at about 75 seconds from
 * the offer, against the 45 the rider is shown.
 */
export function scheduleOfferExpiryJob() {
  let running = false;
  cron.schedule("*/15 * * * * *", async () => {
    // A slow pass must not overlap the next one: both would find the same
    // offers, and the second would only collect 409s.
    if (running) return;
    running = true;
    try {
      const expired = await expireStaleOffers();
      if (expired > 0) logger.info(`Offer expiry: took back ${expired} unanswered offer(s).`);
    } catch (error) {
      logger.error("Offer expiry pass failed:", error);
    } finally {
      running = false;
    }
  });
}
