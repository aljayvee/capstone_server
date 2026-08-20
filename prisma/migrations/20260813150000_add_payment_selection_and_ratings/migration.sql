-- CreateTable
CREATE TABLE `payment_selections` (
    `id` VARCHAR(191) NOT NULL,
    `errandId` VARCHAR(191) NOT NULL,
    `paymentModeId` INTEGER NOT NULL,
    `confirmedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_selections_errandId_key`(`errandId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ratings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `riderId` INTEGER NOT NULL,
    `stars` INTEGER NOT NULL,
    `comment` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ratings_errandId_key`(`errandId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payment_selections` ADD CONSTRAINT `payment_selections_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_selections` ADD CONSTRAINT `payment_selections_paymentModeId_fkey` FOREIGN KEY (`paymentModeId`) REFERENCES `payment_modes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ratings` ADD CONSTRAINT `ratings_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ratings` ADD CONSTRAINT `ratings_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
