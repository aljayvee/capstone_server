-- Who cleared a reconciliation exception, and why.
--
-- The evidence to raise exceptions has been accumulating for a while --
-- settlement variance, receipt divergence, unverified purchases, wrong-branch
-- visits -- and nothing ever looked at it. A list alone is not a control: the
-- same exception reappears on every run and nothing records that a person
-- considered it.
--
-- amountAtRisk is frozen at the moment of resolution on purpose. An exception is
-- derived, so the figures behind it can move afterwards; storing the exposure as
-- it then stood is what makes this row evidence rather than a pointer to a
-- number that has since changed.
--
-- Deliberately NOT unique on (errandId, kind): an owner reviewing something a
-- dispatcher already closed writes a second row, so the sequence of who looked
-- and what they concluded survives.
CREATE TABLE `exception_reviews` (
  `id`           INTEGER      NOT NULL AUTO_INCREMENT,
  `errandId`     VARCHAR(191) NOT NULL,
  `kind`         VARCHAR(40)  NOT NULL,
  `reviewerId`   INTEGER      NOT NULL,
  `reason`       VARCHAR(500) NOT NULL,
  `amountAtRisk` DOUBLE       NOT NULL DEFAULT 0,
  `resolvedAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `exception_reviews_errandId_idx` (`errandId`),
  INDEX `exception_reviews_reviewerId_resolvedAt_idx` (`reviewerId`, `resolvedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `exception_reviews`
  ADD CONSTRAINT `exception_reviews_errandId_fkey`
  FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `exception_reviews`
  ADD CONSTRAINT `exception_reviews_reviewerId_fkey`
  FOREIGN KEY (`reviewerId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- A dwell that ran far past what this kind of shop usually takes.
--
-- detectStalledStop computed exactly this and threw it away: it emitted a socket
-- event and returned, so a rider queueing forty minutes at every supermarket
-- left no trace anyone could look at afterwards. Stored so the pattern is
-- trendable -- and kept out of any amount at risk, because a long queue is a
-- judgement about time, not a claim about money.
ALTER TABLE `dwell_observations`
  ADD COLUMN `stalled` BOOLEAN NOT NULL DEFAULT false;
