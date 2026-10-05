-- 12d. Staff Known Devices Table
-- Tracks recognized devices and browsers to suppress redundant "New Sign-In" alerts.

-- CreateTable
CREATE TABLE `user_known_devices` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `deviceId` VARCHAR(80) NOT NULL,
    `deviceInfo` VARCHAR(120) NULL,
    `userAgent` VARCHAR(300) NULL,
    `ipAddress` VARCHAR(64) NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `user_known_devices_userId_idx`(`userId`),
    UNIQUE INDEX `user_known_devices_userId_deviceId_key`(`userId`, `deviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_known_devices` ADD CONSTRAINT `user_known_devices_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
