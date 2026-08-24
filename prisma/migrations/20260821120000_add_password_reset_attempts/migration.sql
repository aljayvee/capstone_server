-- Audit trail for the customer "forgot password" flow.
--
-- One row per step: the initial request, the code check, the completed reset,
-- and the two rejection paths (honeypot trip, IP throttle). The rows that
-- matter most are the ones with a NULL `customerId` — an identifier that
-- resolved to no account. A single one is a customer misremembering their
-- username; a hundred from one IP is someone enumerating the user table, and
-- that pattern is invisible unless the misses are written down alongside the
-- hits.
--
-- `identifier` stores what was actually typed (lowercased), NOT a foreign key,
-- precisely so a miss is still recorded.

CREATE TABLE `password_reset_attempts` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `identifier` VARCHAR(255) NOT NULL,
  `customerId` INTEGER NULL,
  `outcome` VARCHAR(32) NOT NULL,
  `ipAddress` VARCHAR(64) NULL,
  `userAgent` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `password_reset_attempts_ipAddress_createdAt_idx`(`ipAddress`, `createdAt`),
  INDEX `password_reset_attempts_identifier_idx`(`identifier`),
  INDEX `password_reset_attempts_customerId_idx`(`customerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ON DELETE SET NULL, not CASCADE: deleting a customer must not erase the
-- record that reset attempts were made against their account.
ALTER TABLE `password_reset_attempts`
  ADD CONSTRAINT `password_reset_attempts_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
