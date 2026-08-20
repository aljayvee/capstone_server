-- Registration OTP is issued before a CustomerAccount row exists, so the code
-- is keyed by the contact channel (email or phone) instead of customerId.
-- customerId therefore becomes nullable, and the two channel columns are added.

-- The FK is dropped and re-added around the nullability change so the
-- constraint is rebuilt against the new column definition.
ALTER TABLE `email_verification_codes` DROP FOREIGN KEY `email_verification_codes_customerId_fkey`;

ALTER TABLE `email_verification_codes` MODIFY `customerId` INTEGER NULL;

ALTER TABLE `email_verification_codes` ADD COLUMN `email` VARCHAR(191) NULL;
ALTER TABLE `email_verification_codes` ADD COLUMN `phone` VARCHAR(191) NULL;

CREATE INDEX `email_verification_codes_email_idx` ON `email_verification_codes`(`email`);
CREATE INDEX `email_verification_codes_phone_idx` ON `email_verification_codes`(`phone`);

ALTER TABLE `email_verification_codes` ADD CONSTRAINT `email_verification_codes_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
