-- CreateTable
CREATE TABLE `settlement_adjustments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `settlementId` INTEGER NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `reference` VARCHAR(40) NULL,
    `note` VARCHAR(300) NULL,
    `reviewId` INTEGER NULL,
    `recordedById` INTEGER NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `voidedAt` DATETIME(3) NULL,
    `voidedById` INTEGER NULL,

    INDEX `settlement_adjustments_settlementId_idx`(`settlementId`),
    INDEX `settlement_adjustments_recordedAt_idx`(`recordedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `settlement_adjustments` ADD CONSTRAINT `settlement_adjustments_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `settlement_records`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_adjustments` ADD CONSTRAINT `settlement_adjustments_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `exception_reviews`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_adjustments` ADD CONSTRAINT `settlement_adjustments_recordedById_fkey` FOREIGN KEY (`recordedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_adjustments` ADD CONSTRAINT `settlement_adjustments_voidedById_fkey` FOREIGN KEY (`voidedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

