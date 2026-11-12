-- CreateTable
CREATE TABLE `report_print_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NULL,
    `printedByName` VARCHAR(200) NOT NULL,
    `role` VARCHAR(32) NOT NULL,
    `reportType` VARCHAR(32) NOT NULL,
    `period` VARCHAR(16) NOT NULL,
    `rangeStart` DATETIME(3) NOT NULL,
    `rangeEnd` DATETIME(3) NOT NULL,
    `coverageLabel` VARCHAR(255) NOT NULL,
    `ipAddress` VARCHAR(64) NULL,
    `userAgent` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `report_print_logs_userId_idx`(`userId`),
    INDEX `report_print_logs_reportType_idx`(`reportType`),
    INDEX `report_print_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `report_print_logs` ADD CONSTRAINT `report_print_logs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

