-- CreateTable
CREATE TABLE `settlement_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `riderId` INTEGER NOT NULL,
    `expectedAmount` DOUBLE NOT NULL,
    `collectedAmount` DOUBLE NOT NULL,
    `variance` DOUBLE NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `settledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `settlement_records_errandId_key`(`errandId`),
    INDEX `settlement_records_riderId_idx`(`riderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `settlement_records` ADD CONSTRAINT `settlement_records_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_records` ADD CONSTRAINT `settlement_records_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
