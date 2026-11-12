-- One row per offer a rider declined or let run out.
--
-- errandService.declineErrand hands the errand back by setting errands.riderId
-- to null, which erased the only link between a rider and the offer they
-- refused. The reason they typed survived only in the text of a dispatcher's
-- bell notification. The Rider Performance report could not count declines at
-- all. This table keeps them, and nothing in the app updates or deletes a row.
--
-- Hand-written: `prisma migrate dev` cannot replay history into a shadow DB.
CREATE TABLE `rider_offer_declines` (
  `id`         INTEGER                     NOT NULL AUTO_INCREMENT,
  `riderId`    INTEGER                     NOT NULL,
  `errandId`   VARCHAR(191)                NOT NULL,
  `kind`       ENUM('DECLINED', 'EXPIRED') NOT NULL,
  `reason`     VARCHAR(500)                NULL,
  `offeredAt`  DATETIME(3)                 NULL,
  `declinedAt` DATETIME(3)                 NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `rider_offer_declines_riderId_declinedAt_idx`(`riderId`, `declinedAt`),
  INDEX `rider_offer_declines_errandId_idx`(`errandId`),
  INDEX `rider_offer_declines_declinedAt_idx`(`declinedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `rider_offer_declines`
  ADD CONSTRAINT `rider_offer_declines_riderId_fkey`
  FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `rider_offer_declines`
  ADD CONSTRAINT `rider_offer_declines_errandId_fkey`
  FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
