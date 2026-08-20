-- AlterTable
ALTER TABLE `errands` ADD COLUMN `storeCount` INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE `pabili_item_requests_tbl` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `itemName` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `pabili_item_requests_tbl` ADD CONSTRAINT `pabili_item_requests_tbl_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
