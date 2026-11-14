-- AlterTable
ALTER TABLE `tbl_sysadmin_alerts` ADD COLUMN `incidentId` INTEGER NULL;
-- CreateTable
CREATE TABLE `tbl_sysadmin_incidents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(255) NOT NULL,
    `severity` VARCHAR(20) NOT NULL DEFAULT 'HIGH',
    `status` VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    `sourceKey` VARCHAR(50) NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `recoveredAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `impact` TEXT NULL,
    `cause` TEXT NULL,
    `fix` TEXT NULL,
    `prevention` TEXT NULL,
    `openedBy` VARCHAR(100) NULL,
    `resolvedBy` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `tbl_sysadmin_incidents_status_startedAt_idx`(`status`, `startedAt`),
    INDEX `tbl_sysadmin_incidents_sourceKey_status_idx`(`sourceKey`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- CreateIndex
CREATE INDEX `tbl_sysadmin_alerts_incidentId_idx` ON `tbl_sysadmin_alerts`(`incidentId`);
-- AddForeignKey
ALTER TABLE `tbl_sysadmin_alerts` ADD CONSTRAINT `tbl_sysadmin_alerts_incidentId_fkey` FOREIGN KEY (`incidentId`) REFERENCES `tbl_sysadmin_incidents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
