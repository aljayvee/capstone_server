-- AlterTable
ALTER TABLE `customer_accounts` ADD COLUMN `emailVerified` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `email_verification_codes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NOT NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `email_verification_codes_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `email_verification_codes` ADD CONSTRAINT `email_verification_codes_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
