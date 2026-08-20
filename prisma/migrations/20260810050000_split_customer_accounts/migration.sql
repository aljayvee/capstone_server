-- CreateTable
CREATE TABLE `customer_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'Active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customer_accounts_username_key`(`username`),
    UNIQUE INDEX `customer_accounts_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_information` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `middleName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `avatar` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customer_information_customerId_key`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_transactions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NOT NULL,
    `errandId` VARCHAR(191) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `paymentMethod` VARCHAR(191) NOT NULL DEFAULT 'COD',
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customer_transactions_errandId_key`(`errandId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `customer_information` ADD CONSTRAINT `customer_information_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_transactions` ADD CONSTRAINT `customer_transactions_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_transactions` ADD CONSTRAINT `customer_transactions_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- DataMigration: move the one live CUSTOMER-role row out of `users` into the new
-- customer tables, reusing the same id so errands.customerId / saved_delivery_locations.userId
-- keep pointing at the right row with no FK rewrite needed (confirmed exactly one
-- CUSTOMER row exists today: id=15, username 'hav' — no collision risk).
INSERT INTO `customer_accounts` (`id`, `username`, `passwordHash`, `email`, `status`, `createdAt`, `updatedAt`)
SELECT `id`, `username`, `passwordHash`, `email`, `status`, `createdAt`, `updatedAt` FROM `users` WHERE `role` = 'CUSTOMER';

INSERT INTO `customer_information` (`customerId`, `firstName`, `middleName`, `lastName`, `phone`, `avatar`, `createdAt`, `updatedAt`)
SELECT `id`, `firstName`, `middleName`, `lastName`, `phone`, `avatar`, `createdAt`, `updatedAt` FROM `users` WHERE `role` = 'CUSTOMER';

-- Realign AUTO_INCREMENT so future customer_accounts inserts don't collide with the migrated id.
-- Literal value confirmed directly against the live DB before writing this migration: exactly
-- one CUSTOMER row exists (users.id=15), so MAX(customer_accounts.id) after the insert above is 15.
ALTER TABLE `customer_accounts` AUTO_INCREMENT = 16;

-- DropForeignKey
ALTER TABLE `errands` DROP FOREIGN KEY `errands_customerId_fkey`;

-- DropForeignKey
ALTER TABLE `saved_delivery_locations` DROP FOREIGN KEY `saved_delivery_locations_userId_fkey`;

-- RenameColumn (CHANGE, not DROP+ADD, so existing saved-location rows keep their data)
ALTER TABLE `saved_delivery_locations` CHANGE COLUMN `userId` `customerId` INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE `errands` ADD CONSTRAINT `errands_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `saved_delivery_locations` ADD CONSTRAINT `saved_delivery_locations_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigration: now that FKs point at customer_accounts, remove the migrated row from `users`.
DELETE FROM `users` WHERE `role` = 'CUSTOMER';

-- AlterTable: narrow `users.role` — CUSTOMER never stored here again.
ALTER TABLE `users` MODIFY `role` ENUM('OWNER', 'DISPATCHER', 'RIDER') NOT NULL;
