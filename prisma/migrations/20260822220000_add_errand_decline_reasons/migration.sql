-- Why a dispatcher declined an errand.
--
-- The dispatcher console has always asked for a reason and always thrown it
-- away: it was posted to PATCH /errands/:id/status, which only reads `status`.
-- The errand went CANCELLED and the reason existed nowhere, so the customer was
-- told their request was cancelled with no explanation, and an owner reviewing
-- the week had no way to see that half the declines said "store closed".
--
-- A separate table rather than a column on `errands` because a reason is a
-- decision made by a specific person at a specific time — it has an author and
-- a timestamp of its own. Deliberately not unique per errand: an errand could
-- be reopened and declined again, and overwriting would destroy the record this
-- table exists to keep.
CREATE TABLE `errand_decline_reasons` (
  `id`           INTEGER      NOT NULL AUTO_INCREMENT,
  `errandId`     VARCHAR(191) NOT NULL,
  `dispatcherId` INTEGER      NOT NULL,
  `reason`       VARCHAR(255) NOT NULL,
  `isCustom`     BOOLEAN      NOT NULL DEFAULT false,
  `createdAt`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `errand_decline_reasons_errandId_idx`(`errandId`),
  INDEX `errand_decline_reasons_dispatcherId_idx`(`dispatcherId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `errand_decline_reasons`
  ADD CONSTRAINT `errand_decline_reasons_errandId_fkey`
  FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `errand_decline_reasons`
  ADD CONSTRAINT `errand_decline_reasons_dispatcherId_fkey`
  FOREIGN KEY (`dispatcherId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
