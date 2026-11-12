-- Additive: existing clients/rows retain NULL identities. MariaDB permits
-- multiple NULL values in a unique index, preserving their original behavior.
ALTER TABLE `errands`
  ADD COLUMN `submissionId` VARCHAR(80) NULL,
  ADD COLUMN `submissionHash` CHAR(64) NULL,
  ADD UNIQUE INDEX `errands_customerId_submissionId_key` (`customerId`, `submissionId`);
