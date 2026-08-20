-- CreateTable
CREATE TABLE `connectivity_incidents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `riderId` INTEGER NOT NULL,
    `errandId` VARCHAR(191) NULL,
    `disconnectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reconnectedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `connectivity_incidents_riderId_idx`(`riderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `connectivity_incidents` ADD CONSTRAINT `connectivity_incidents_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `connectivity_incidents` ADD CONSTRAINT `connectivity_incidents_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
