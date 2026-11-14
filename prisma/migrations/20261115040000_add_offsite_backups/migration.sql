-- AlterTable
ALTER TABLE `tbl_database_backups` ADD COLUMN `offsiteAt` DATETIME(3) NULL,
    ADD COLUMN `offsiteError` TEXT NULL,
    ADD COLUMN `offsitePath` VARCHAR(500) NULL,
    ADD COLUMN `offsiteSizeBytes` BIGINT NULL,
    ADD COLUMN `offsiteStatus` VARCHAR(20) NULL;
-- CreateTable
CREATE TABLE `tbl_backup_restore_checks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `trigger` VARCHAR(20) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
    `backupFile` VARCHAR(255) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,
    `tablesRestored` INTEGER NULL,
    `rowsRestored` BIGINT NULL,
    `details` JSON NULL,
    `error` TEXT NULL,
    `triggeredBy` VARCHAR(100) NULL,
    INDEX `tbl_backup_restore_checks_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- CreateIndex
CREATE INDEX `tbl_database_backups_offsiteStatus_createdAt_idx` ON `tbl_database_backups`(`offsiteStatus`, `createdAt`);
