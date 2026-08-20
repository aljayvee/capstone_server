-- AlterTable
ALTER TABLE `errand_pinpoints_tbl` ADD COLUMN `arrivedAt` DATETIME(3) NULL,
    ADD COLUMN `categoryId` INTEGER NULL,
    ADD COLUMN `departedAt` DATETIME(3) NULL,
    ADD COLUMN `legDistanceMeters` INTEGER NULL,
    ADD COLUMN `legDurationSeconds` INTEGER NULL,
    ADD COLUMN `placeId` VARCHAR(36) NULL,
    ADD COLUMN `sequenceLocked` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `errands` ADD COLUMN `acceptedAt` DATETIME(3) NULL,
    ADD COLUMN `assignedAt` DATETIME(3) NULL,
    ADD COLUMN `completedAt` DATETIME(3) NULL,
    ADD COLUMN `deliveredAt` DATETIME(3) NULL,
    ADD COLUMN `distanceKm` DOUBLE NULL,
    ADD COLUMN `etaComputedAt` DATETIME(3) NULL,
    ADD COLUMN `etaHighAt` DATETIME(3) NULL,
    ADD COLUMN `etaIsDegraded` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `etaLowAt` DATETIME(3) NULL,
    ADD COLUMN `routeDistanceMeters` INTEGER NULL,
    ADD COLUMN `routeDurationSeconds` INTEGER NULL,
    ADD COLUMN `routeGeometry` TEXT NULL,
    ADD COLUMN `routeProvider` VARCHAR(20) NULL,
    ADD COLUMN `routedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `merchant_categories` ADD COLUMN `dwellP50Seconds` INTEGER NOT NULL DEFAULT 600,
    ADD COLUMN `dwellP80Seconds` INTEGER NOT NULL DEFAULT 1200,
    ADD COLUMN `dwellSampleCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `dwellUpdatedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `errand_track_points` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `riderId` INTEGER NOT NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `accuracyMeters` DOUBLE NULL,
    `speedMps` DOUBLE NULL,
    `headingDeg` DOUBLE NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isMapMatched` BOOLEAN NOT NULL DEFAULT false,
    `wasOffline` BOOLEAN NOT NULL DEFAULT false,
    `clientPointId` VARCHAR(36) NOT NULL,

    INDEX `errand_track_points_errandId_recordedAt_idx`(`errandId`, `recordedAt`),
    INDEX `errand_track_points_riderId_recordedAt_idx`(`riderId`, `recordedAt`),
    UNIQUE INDEX `errand_track_points_errandId_clientPointId_key`(`errandId`, `clientPointId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dwell_observations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `pinpointId` INTEGER NOT NULL,
    `categoryId` INTEGER NULL,
    `placeId` VARCHAR(36) NULL,
    `dwellSeconds` INTEGER NOT NULL,
    `arrivedAt` DATETIME(3) NOT NULL,
    `departedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `dwell_observations_categoryId_createdAt_idx`(`categoryId`, `createdAt`),
    INDEX `dwell_observations_placeId_createdAt_idx`(`placeId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `errand_pinpoints_tbl` ADD CONSTRAINT `errand_pinpoints_tbl_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `merchant_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_pinpoints_tbl` ADD CONSTRAINT `errand_pinpoints_tbl_placeId_fkey` FOREIGN KEY (`placeId`) REFERENCES `verified_places`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_track_points` ADD CONSTRAINT `errand_track_points_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_track_points` ADD CONSTRAINT `errand_track_points_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dwell_observations` ADD CONSTRAINT `dwell_observations_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dwell_observations` ADD CONSTRAINT `dwell_observations_pinpointId_fkey` FOREIGN KEY (`pinpointId`) REFERENCES `errand_pinpoints_tbl`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dwell_observations` ADD CONSTRAINT `dwell_observations_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `merchant_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dwell_observations` ADD CONSTRAINT `dwell_observations_placeId_fkey` FOREIGN KEY (`placeId`) REFERENCES `verified_places`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER TABLE `errand_pinpoints_tbl` RENAME INDEX `errand_pinpoints_tbl_errandId_fkey` TO `errand_pinpoints_tbl_errandId_idx`;

