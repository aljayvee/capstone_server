-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `role` ENUM('OWNER', 'DISPATCHER', 'RIDER') NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `middleName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `avatar` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'Active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `updatedBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `emailVerified` BOOLEAN NOT NULL DEFAULT false,
    `emailVerifiedAt` DATETIME(3) NULL,
    `profileCompleted` BOOLEAN NOT NULL DEFAULT true,
    `expoPushToken` VARCHAR(191) NULL,

    UNIQUE INDEX `users_username_key`(`username`),
    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rider_profile_photos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `photoData` LONGTEXT NOT NULL,
    `mimeType` VARCHAR(50) NOT NULL,
    `fileSize` INTEGER NOT NULL,
    `fileName` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `rider_profile_photos_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
    `beaconIntervalMs` INTEGER NULL,
    `recordedAt` DATETIME(3) NULL,
    `lastBeaconAt` DATETIME(3) NULL,
    `shutdownAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `rider_presence_riderId_key`(`riderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'Active',
    `emailVerified` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `expoPushToken` VARCHAR(191) NULL,

    UNIQUE INDEX `customer_accounts_username_key`(`username`),
    UNIQUE INDEX `customer_accounts_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_information` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `middleName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `birthdate` DATE NULL,
    `phone` VARCHAR(191) NOT NULL,
    `avatar` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customer_information_customerId_key`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_profile_photos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NOT NULL,
    `photoData` LONGTEXT NOT NULL,
    `mimeType` VARCHAR(50) NOT NULL,
    `fileSize` INTEGER NOT NULL,
    `fileName` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customer_profile_photos_customerId_key`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_transactions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NOT NULL,
    `errandId` VARCHAR(191) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `paymentMethod` VARCHAR(191) NOT NULL DEFAULT 'COD',
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customer_transactions_errandId_key`(`errandId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `merchant_categories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'Active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `handlingFeeMode` ENUM('THRESHOLD', 'FLAT', 'PERCENT', 'NONE') NOT NULL DEFAULT 'THRESHOLD',
    `dwellP50Seconds` INTEGER NOT NULL DEFAULT 600,
    `dwellP80Seconds` INTEGER NOT NULL DEFAULT 1200,
    `dwellSampleCount` INTEGER NOT NULL DEFAULT 0,
    `dwellUpdatedAt` DATETIME(3) NULL,
    `geofenceRadiusMeters` INTEGER NOT NULL DEFAULT 75,

    UNIQUE INDEX `merchant_categories_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `store_cat_image` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `categoryId` INTEGER NOT NULL,
    `imageData` LONGTEXT NOT NULL,
    `mimeType` VARCHAR(50) NOT NULL,
    `fileSize` INTEGER NOT NULL,
    `fileName` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `store_cat_image_categoryId_key`(`categoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_modes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'Active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_modes_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `errands` (
    `id` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `pickupAddress` VARCHAR(191) NOT NULL,
    `deliveryAddress` VARCHAR(191) NOT NULL,
    `deliveryLatitude` DOUBLE NULL,
    `deliveryLongitude` DOUBLE NULL,
    `estimatedCost` DOUBLE NOT NULL DEFAULT 0,
    `deliveryFee` DOUBLE NOT NULL DEFAULT 50,
    `tip` DOUBLE NOT NULL DEFAULT 0,
    `totalCost` DOUBLE NOT NULL DEFAULT 50,
    `status` ENUM('AVAILABLE', 'PENDING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `storeCount` INTEGER NOT NULL DEFAULT 1,
    `customerId` INTEGER NOT NULL,
    `riderId` INTEGER NULL,
    `paymentModeId` INTEGER NULL,
    `paymentEnabledAt` DATETIME(3) NULL,
    `paymentEnabledByDispatcherId` INTEGER NULL,
    `itemsPurchasedAt` DATETIME(3) NULL,
    `halfPaymentRequestedAt` DATETIME(3) NULL,
    `overageEscalatedAt` DATETIME(3) NULL,
    `overageResolvedAt` DATETIME(3) NULL,
    `assignedAt` DATETIME(3) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `distanceKm` DOUBLE NULL,
    `routeDistanceMeters` INTEGER NULL,
    `routeDurationSeconds` INTEGER NULL,
    `routeGeometry` TEXT NULL,
    `routeProvider` VARCHAR(20) NULL,
    `routedAt` DATETIME(3) NULL,
    `multiStoreFee` DOUBLE NULL,
    `groceryFee` DOUBLE NULL,
    `nonCodFee` DOUBLE NULL,
    `distanceFee` DOUBLE NULL,
    `feeCalculatedAt` DATETIME(3) NULL,
    `quotedHandlingBasket` DOUBLE NULL,
    `quotedHandlingFee` DOUBLE NULL,
    `quotedDeliveryFee` DOUBLE NULL,
    `handlingFeeDecision` JSON NULL,
    `etaLowAt` DATETIME(3) NULL,
    `etaHighAt` DATETIME(3) NULL,
    `etaComputedAt` DATETIME(3) NULL,
    `etaIsDegraded` BOOLEAN NOT NULL DEFAULT false,
    `proximity_alert_sent_at` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pabili_details_tbl` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `itemName` VARCHAR(191) NOT NULL,
    `storeCategory` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `unitPrice` DOUBLE NOT NULL DEFAULT 0,
    `estimatedSubtotal` DOUBLE NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `pinpointId` INTEGER NULL,

    INDEX `pabili_details_tbl_pinpointId_idx`(`pinpointId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pabili_item_requests_tbl` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `itemName` VARCHAR(191) NOT NULL,
    `storeCategory` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `pinpointId` INTEGER NULL,

    INDEX `pabili_item_requests_tbl_pinpointId_idx`(`pinpointId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `errand_pinpoints_tbl` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `sequence` INTEGER NOT NULL DEFAULT 0,
    `storeName` VARCHAR(191) NOT NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `categoryId` INTEGER NULL,
    `placeId` VARCHAR(36) NULL,
    `observedPlaceId` VARCHAR(36) NULL,
    `mismatchDetectedAt` DATETIME(3) NULL,
    `arrivedAt` DATETIME(3) NULL,
    `departedAt` DATETIME(3) NULL,
    `legDistanceMeters` INTEGER NULL,
    `legDurationSeconds` INTEGER NULL,
    `sequenceLocked` BOOLEAN NOT NULL DEFAULT false,

    INDEX `errand_pinpoints_tbl_errandId_idx`(`errandId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exception_reviews` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(40) NOT NULL,
    `reviewerId` INTEGER NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `amountAtRisk` DOUBLE NOT NULL DEFAULT 0,
    `resolvedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `exception_reviews_errandId_idx`(`errandId`),
    INDEX `exception_reviews_reviewerId_resolvedAt_idx`(`reviewerId`, `resolvedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispatch_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `dispatcherId` INTEGER NOT NULL,
    `notes` VARCHAR(191) NULL,
    `dispatchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `verifiedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `errand_decline_reasons` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `dispatcherId` INTEGER NOT NULL,
    `reason` VARCHAR(255) NOT NULL,
    `isCustom` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `errand_decline_reasons_errandId_idx`(`errandId`),
    INDEX `errand_decline_reasons_dispatcherId_idx`(`dispatcherId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rate_configs` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `baseFee` DOUBLE NOT NULL,
    `perKmRate` DOUBLE NOT NULL DEFAULT 10,
    `multiStoreFeePerStore` DOUBLE NOT NULL DEFAULT 30,
    `maxAdditionalStores` INTEGER NOT NULL DEFAULT 2,
    `groceryFeeThreshold` DOUBLE NOT NULL DEFAULT 1001,
    `groceryFeePercent` DOUBLE NOT NULL DEFAULT 10,
    `groceryFeeFlat` DOUBLE NOT NULL DEFAULT 50,
    `nonCodThreshold` DOUBLE NOT NULL DEFAULT 3000,
    `nonCodFeeHigh` DOUBLE NOT NULL DEFAULT 15,
    `nonCodFeeLow` DOUBLE NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `saved_delivery_locations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `address` VARCHAR(191) NOT NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_sessions` (
    `id` VARCHAR(36) NOT NULL,
    `subjectId` INTEGER NOT NULL,
    `subjectType` VARCHAR(16) NOT NULL,
    `role` VARCHAR(20) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `previousHash` CHAR(64) NULL,
    `rotatedAt` DATETIME(3) NULL,
    `deviceId` VARCHAR(80) NULL,
    `userAgent` VARCHAR(300) NULL,
    `ipAddress` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUsedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(64) NULL,

    INDEX `user_sessions_subjectType_subjectId_idx`(`subjectType`, `subjectId`),
    INDEX `user_sessions_expiresAt_idx`(`expiresAt`),
    INDEX `user_sessions_tokenHash_idx`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `account_login_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `role` VARCHAR(20) NOT NULL,
    `ipAddress` VARCHAR(64) NOT NULL,
    `userAgent` VARCHAR(300) NOT NULL,
    `deviceInfo` VARCHAR(120) NULL,
    `status` VARCHAR(32) NOT NULL,
    `sessionId` VARCHAR(36) NULL,
    `isOnline` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(64) NULL,

    INDEX `account_login_logs_userId_role_idx`(`userId`, `role`),
    INDEX `account_login_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `token_blocklist` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token` VARCHAR(500) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `token_blocklist_token_key`(`token`),
    INDEX `token_blocklist_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tbl_sys_admin` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(50) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `firstName` VARCHAR(100) NULL,
    `middleName` VARCHAR(100) NULL,
    `lastName` VARCHAR(100) NULL,
    `nickname` VARCHAR(50) NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(30) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'Active',
    `role` VARCHAR(20) NOT NULL DEFAULT 'SYSADMIN',
    `profileCompleted` BOOLEAN NOT NULL DEFAULT false,
    `emailVerified` BOOLEAN NOT NULL DEFAULT false,
    `emailVerifiedAt` DATETIME(3) NULL,
    `verificationTokenHash` VARCHAR(255) NULL,
    `verificationTokenExpiresAt` DATETIME(3) NULL,
    `profileOtpHash` VARCHAR(255) NULL,
    `profileOtpExpiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `failedLoginAttempts` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `unlockTokenHash` VARCHAR(255) NULL,
    `unlockTokenExpiresAt` DATETIME(3) NULL,
    `enforceTwoFactor` BOOLEAN NOT NULL DEFAULT false,
    `twoFactorCodeHash` VARCHAR(255) NULL,
    `twoFactorExpiresAt` DATETIME(3) NULL,

    UNIQUE INDEX `tbl_sys_admin_username_key`(`username`),
    UNIQUE INDEX `tbl_sys_admin_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tbl_sys_admin_trusted_devices` (
    `id` VARCHAR(191) NOT NULL,
    `adminId` INTEGER NOT NULL,
    `deviceFingerprint` VARCHAR(128) NOT NULL,
    `deviceTokenHash` VARCHAR(255) NOT NULL,
    `ipAddress` VARCHAR(45) NOT NULL,
    `userAgent` TEXT NOT NULL,
    `lastUsedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `tbl_sys_admin_trusted_devices_adminId_idx`(`adminId`),
    INDEX `tbl_sys_admin_trusted_devices_deviceTokenHash_idx`(`deviceTokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tbl_sys_admin_password_history` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `adminId` INTEGER NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `tbl_sys_admin_password_history_adminId_idx`(`adminId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tbl_blocked_ips` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ipAddress` VARCHAR(45) NOT NULL,
    `reason` VARCHAR(255) NOT NULL,
    `banType` ENUM('AUTOMATIC', 'MANUAL') NOT NULL DEFAULT 'AUTOMATIC',
    `severity` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL DEFAULT 'HIGH',
    `status` ENUM('ACTIVE', 'EXPIRED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `blockedUntil` DATETIME(3) NULL,
    `attackCount` INTEGER NOT NULL DEFAULT 1,
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `bannedById` INTEGER NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `tbl_blocked_ips_ipAddress_status_idx`(`ipAddress`, `status`),
    INDEX `tbl_blocked_ips_blockedUntil_idx`(`blockedUntil`),
    INDEX `tbl_blocked_ips_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tbl_whitelisted_ips` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ipAddress` VARCHAR(45) NOT NULL,
    `cidrBlock` VARCHAR(50) NULL,
    `description` VARCHAR(255) NOT NULL,
    `isImmune` BOOLEAN NOT NULL DEFAULT false,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tbl_whitelisted_ips_ipAddress_key`(`ipAddress`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tbl_database_backups` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fileName` VARCHAR(255) NOT NULL,
    `fileSizeBytes` BIGINT NOT NULL DEFAULT 0,
    `filePath` VARCHAR(500) NOT NULL,
    `backupType` VARCHAR(50) NOT NULL DEFAULT 'AUTOMATED',
    `status` VARCHAR(50) NOT NULL DEFAULT 'COMPLETED',
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `tbl_database_backups_fileName_key`(`fileName`),
    INDEX `tbl_database_backups_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tbl_sysadmin_alerts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `alertType` VARCHAR(50) NOT NULL,
    `severity` VARCHAR(20) NOT NULL DEFAULT 'HIGH',
    `title` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `channel` VARCHAR(50) NOT NULL DEFAULT 'TELEGRAM',
    `status` VARCHAR(50) NOT NULL DEFAULT 'SENT',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `tbl_sysadmin_alerts_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
CREATE TABLE `errand_payments` (
    `id` VARCHAR(191) NOT NULL,
    `errandId` VARCHAR(191) NOT NULL,
    `kind` ENUM('UPFRONT', 'TOP_UP', 'FINAL', 'REFUND') NOT NULL,
    `amount` DOUBLE NOT NULL,
    `confirmedByUserId` INTEGER NULL,
    `confirmedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `note` VARCHAR(255) NULL,
    `proofImageId` INTEGER NULL,

    UNIQUE INDEX `errand_payments_proofImageId_key`(`proofImageId`),
    INDEX `errand_payments_errandId_idx`(`errandId`),
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

-- CreateTable
CREATE TABLE `email_verification_codes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customerId` INTEGER NULL,
    `userId` INTEGER NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `email_verification_codes_customerId_idx`(`customerId`),
    INDEX `email_verification_codes_userId_idx`(`userId`),
    INDEX `email_verification_codes_email_idx`(`email`),
    INDEX `email_verification_codes_phone_idx`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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

-- CreateTable
CREATE TABLE `settlement_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `riderId` INTEGER NOT NULL,
    `expectedAmount` DOUBLE NOT NULL,
    `collectedAmount` DOUBLE NOT NULL,
    `variance` DOUBLE NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `shortReason` VARCHAR(300) NULL,
    `proofImageId` INTEGER NULL,
    `settledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `settlement_records_errandId_key`(`errandId`),
    UNIQUE INDEX `settlement_records_proofImageId_key`(`proofImageId`),
    INDEX `settlement_records_riderId_idx`(`riderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `errand_proof_images` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `pinpointId` INTEGER NULL,
    `riderId` INTEGER NULL,
    `customerId` INTEGER NULL,
    `kind` ENUM('RECEIPT', 'TRANSFER', 'PROOF_OF_DELIVERY', 'NO_RECEIPT', 'PAYMENT_PROOF', 'RIDER_BALANCE_PROOF', 'CASH_COLLECTED') NOT NULL,
    `imageData` LONGTEXT NOT NULL,
    `mimeType` VARCHAR(30) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `clarityScore` DOUBLE NULL,
    `clarityVerdict` ENUM('SHARP', 'ACCEPTABLE', 'TOO_BLURRY', 'TOO_DARK') NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `verified` BOOLEAN NOT NULL DEFAULT true,
    `declaredTotal` DOUBLE NULL,
    `supersededAt` DATETIME(3) NULL,

    INDEX `errand_proof_images_errandId_idx`(`errandId`),
    INDEX `errand_proof_images_riderId_idx`(`riderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `receipt_extractions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `proofImageId` INTEGER NOT NULL,
    `engine` ENUM('MLKIT', 'CLOUD_VISION') NOT NULL,
    `rawText` LONGTEXT NULL,
    `extractedTotal` DOUBLE NULL,
    `extractedDate` DATETIME(3) NULL,
    `confidence` DOUBLE NULL,
    `status` ENUM('OK', 'NEEDS_REVIEW', 'FAILED') NOT NULL DEFAULT 'NEEDS_REVIEW',
    `referenceNo` VARCHAR(40) NULL,
    `transactionId` VARCHAR(40) NULL,
    `confirmedTotal` DOUBLE NULL,
    `confirmedAt` DATETIME(3) NULL,
    `extractedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `receipt_extractions_proofImageId_key`(`proofImageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rider_commissions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `errandId` VARCHAR(191) NOT NULL,
    `riderId` INTEGER NOT NULL,
    `deliveryFee` DOUBLE NOT NULL,
    `tip` DOUBLE NOT NULL,
    `commissionRate` DOUBLE NOT NULL,
    `riderShare` DOUBLE NOT NULL,
    `businessShare` DOUBLE NOT NULL,
    `itemCostExcluded` DOUBLE NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `rider_commissions_errandId_key`(`errandId`),
    INDEX `rider_commissions_riderId_idx`(`riderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rider_login_sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `riderId` INTEGER NOT NULL,
    `loginAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `logoutAt` DATETIME(3) NULL,
    `durationSeconds` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `rider_login_sessions_riderId_idx`(`riderId`),
    INDEX `rider_login_sessions_riderId_logoutAt_idx`(`riderId`, `logoutAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rider_status_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `riderId` INTEGER NOT NULL,
    `status` ENUM('ONLINE', 'OFFLINE') NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `rider_status_logs_riderId_recordedAt_idx`(`riderId`, `recordedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NULL,
    `customerId` INTEGER NULL,
    `type` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `body` VARCHAR(191) NOT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_userId_idx`(`userId`),
    INDEX `notifications_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `account_modification_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `role` VARCHAR(191) NOT NULL,
    `userId` INTEGER NULL,
    `customerId` INTEGER NULL,
    `fieldModified` VARCHAR(191) NOT NULL,
    `oldValue` TEXT NULL,
    `newValue` TEXT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `userAgent` VARCHAR(191) NULL,
    `verifiedVia` VARCHAR(191) NOT NULL DEFAULT 'RECAPTCHA',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `account_modification_logs_userId_idx`(`userId`),
    INDEX `account_modification_logs_customerId_idx`(`customerId`),
    INDEX `account_modification_logs_role_idx`(`role`),
    INDEX `account_modification_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_reset_attempts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `identifier` VARCHAR(255) NOT NULL,
    `customerId` INTEGER NULL,
    `outcome` VARCHAR(32) NOT NULL,
    `ipAddress` VARCHAR(64) NULL,
    `userAgent` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `password_reset_attempts_ipAddress_createdAt_idx`(`ipAddress`, `createdAt`),
    INDEX `password_reset_attempts_identifier_idx`(`identifier`),
    INDEX `password_reset_attempts_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verified_places` (
    `id` VARCHAR(36) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `categoryId` INTEGER NOT NULL,
    `address` VARCHAR(255) NOT NULL,
    `barangay` VARCHAR(80) NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `keywords` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `verified_places_name_idx`(`name`),
    INDEX `verified_places_categoryId_idx`(`categoryId`),
    INDEX `verified_places_barangay_idx`(`barangay`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
    `stalled` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `dwell_observations_categoryId_createdAt_idx`(`categoryId`, `createdAt`),
    INDEX `dwell_observations_placeId_createdAt_idx`(`placeId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_updatedBy_fkey` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rider_profile_photos` ADD CONSTRAINT `rider_profile_photos_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rider_presence` ADD CONSTRAINT `rider_presence_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_information` ADD CONSTRAINT `customer_information_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_profile_photos` ADD CONSTRAINT `customer_profile_photos_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_transactions` ADD CONSTRAINT `customer_transactions_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_transactions` ADD CONSTRAINT `customer_transactions_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `store_cat_image` ADD CONSTRAINT `store_cat_image_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `merchant_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errands` ADD CONSTRAINT `errands_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errands` ADD CONSTRAINT `errands_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errands` ADD CONSTRAINT `errands_paymentModeId_fkey` FOREIGN KEY (`paymentModeId`) REFERENCES `payment_modes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errands` ADD CONSTRAINT `errands_paymentEnabledByDispatcherId_fkey` FOREIGN KEY (`paymentEnabledByDispatcherId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pabili_details_tbl` ADD CONSTRAINT `pabili_details_tbl_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pabili_details_tbl` ADD CONSTRAINT `pabili_details_tbl_pinpointId_fkey` FOREIGN KEY (`pinpointId`) REFERENCES `errand_pinpoints_tbl`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pabili_item_requests_tbl` ADD CONSTRAINT `pabili_item_requests_tbl_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pabili_item_requests_tbl` ADD CONSTRAINT `pabili_item_requests_tbl_pinpointId_fkey` FOREIGN KEY (`pinpointId`) REFERENCES `errand_pinpoints_tbl`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_pinpoints_tbl` ADD CONSTRAINT `errand_pinpoints_tbl_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_pinpoints_tbl` ADD CONSTRAINT `errand_pinpoints_tbl_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `merchant_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_pinpoints_tbl` ADD CONSTRAINT `errand_pinpoints_tbl_placeId_fkey` FOREIGN KEY (`placeId`) REFERENCES `verified_places`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_pinpoints_tbl` ADD CONSTRAINT `errand_pinpoints_tbl_observedPlaceId_fkey` FOREIGN KEY (`observedPlaceId`) REFERENCES `verified_places`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `exception_reviews` ADD CONSTRAINT `exception_reviews_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `exception_reviews` ADD CONSTRAINT `exception_reviews_reviewerId_fkey` FOREIGN KEY (`reviewerId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dispatch_logs` ADD CONSTRAINT `dispatch_logs_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dispatch_logs` ADD CONSTRAINT `dispatch_logs_dispatcherId_fkey` FOREIGN KEY (`dispatcherId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_decline_reasons` ADD CONSTRAINT `errand_decline_reasons_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_decline_reasons` ADD CONSTRAINT `errand_decline_reasons_dispatcherId_fkey` FOREIGN KEY (`dispatcherId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `saved_delivery_locations` ADD CONSTRAINT `saved_delivery_locations_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tbl_sys_admin_trusted_devices` ADD CONSTRAINT `tbl_sys_admin_trusted_devices_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `tbl_sys_admin`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tbl_sys_admin_password_history` ADD CONSTRAINT `tbl_sys_admin_password_history_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `tbl_sys_admin`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tbl_blocked_ips` ADD CONSTRAINT `tbl_blocked_ips_bannedById_fkey` FOREIGN KEY (`bannedById`) REFERENCES `tbl_sys_admin`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tbl_whitelisted_ips` ADD CONSTRAINT `tbl_whitelisted_ips_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `tbl_sys_admin`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tbl_database_backups` ADD CONSTRAINT `tbl_database_backups_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `tbl_sys_admin`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_selections` ADD CONSTRAINT `payment_selections_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_selections` ADD CONSTRAINT `payment_selections_paymentModeId_fkey` FOREIGN KEY (`paymentModeId`) REFERENCES `payment_modes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_payments` ADD CONSTRAINT `errand_payments_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_payments` ADD CONSTRAINT `errand_payments_confirmedByUserId_fkey` FOREIGN KEY (`confirmedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_payments` ADD CONSTRAINT `errand_payments_proofImageId_fkey` FOREIGN KEY (`proofImageId`) REFERENCES `errand_proof_images`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ratings` ADD CONSTRAINT `ratings_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ratings` ADD CONSTRAINT `ratings_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_verification_codes` ADD CONSTRAINT `email_verification_codes_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_verification_codes` ADD CONSTRAINT `email_verification_codes_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `connectivity_incidents` ADD CONSTRAINT `connectivity_incidents_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `connectivity_incidents` ADD CONSTRAINT `connectivity_incidents_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_records` ADD CONSTRAINT `settlement_records_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_records` ADD CONSTRAINT `settlement_records_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement_records` ADD CONSTRAINT `settlement_records_proofImageId_fkey` FOREIGN KEY (`proofImageId`) REFERENCES `errand_proof_images`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_proof_images` ADD CONSTRAINT `errand_proof_images_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_proof_images` ADD CONSTRAINT `errand_proof_images_pinpointId_fkey` FOREIGN KEY (`pinpointId`) REFERENCES `errand_pinpoints_tbl`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_proof_images` ADD CONSTRAINT `errand_proof_images_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `errand_proof_images` ADD CONSTRAINT `errand_proof_images_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipt_extractions` ADD CONSTRAINT `receipt_extractions_proofImageId_fkey` FOREIGN KEY (`proofImageId`) REFERENCES `errand_proof_images`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rider_commissions` ADD CONSTRAINT `rider_commissions_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rider_commissions` ADD CONSTRAINT `rider_commissions_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rider_login_sessions` ADD CONSTRAINT `rider_login_sessions_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rider_status_logs` ADD CONSTRAINT `rider_status_logs_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account_modification_logs` ADD CONSTRAINT `account_modification_logs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account_modification_logs` ADD CONSTRAINT `account_modification_logs_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `password_reset_attempts` ADD CONSTRAINT `password_reset_attempts_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verified_places` ADD CONSTRAINT `verified_places_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `merchant_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

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

