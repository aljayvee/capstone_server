-- CreateTable
CREATE TABLE `rider_presence` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `riderId` INTEGER NOT NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `accuracyMeters` DOUBLE NULL,
    `headingDeg` DOUBLE NULL,
    `onDuty` BOOLEAN NOT NULL DEFAULT false,
    `backgroundLocation` BOOLEAN NOT NULL DEFAULT false,
    `notifications` BOOLEAN NOT NULL DEFAULT false,
    `exactAlarms` BOOLEAN NOT NULL DEFAULT false,
    `connectivity` VARCHAR(16) NULL,
    `recordedAt` DATETIME(3) NULL,
    `lastBeaconAt` DATETIME(3) NULL,
    `shutdownAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `rider_presence_riderId_key`(`riderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `rider_presence` ADD CONSTRAINT `rider_presence_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
