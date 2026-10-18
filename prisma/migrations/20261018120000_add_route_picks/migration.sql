-- 18b. Route Picks (2026-10-18)
-- One row per fastest-route decision made for a Sugo Rider rider: whose path
-- won, which map (OpenStreetMap or Google) it was drawn on, why that map, and
-- both engines' ETA and distance. Additive only: a new table, nothing existing
-- is changed. Written by lib/routing/routePickLog.ts.

-- CreateTable
CREATE TABLE `route_picks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `riderId` INTEGER NOT NULL,
    `day` DATE NOT NULL,
    `mapSource` VARCHAR(10) NOT NULL,
    `mapAsked` VARCHAR(10) NULL,
    `chosen` VARCHAR(10) NOT NULL,
    `drawnWith` VARCHAR(10) NOT NULL,
    `osrmDurationSeconds` INTEGER NULL,
    `osrmDistanceMeters` INTEGER NULL,
    `googleDurationSeconds` INTEGER NULL,
    `googleDistanceMeters` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `route_picks_day_mapSource_idx`(`day`, `mapSource`),
    INDEX `route_picks_riderId_day_idx`(`riderId`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `route_picks` ADD CONSTRAINT `route_picks_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
