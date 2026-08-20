-- AlterTable
ALTER TABLE `users` ADD COLUMN `expoPushToken` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `errand_pinpoints_tbl` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `sequence` INTEGER NOT NULL DEFAULT 0,
    `storeName` VARCHAR(191) NOT NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `errand_pinpoints_tbl` ADD CONSTRAINT `errand_pinpoints_tbl_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
