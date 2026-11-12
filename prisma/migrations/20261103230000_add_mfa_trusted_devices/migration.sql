-- One row per device that passed the second sign-in factor (MFA).
--
-- A sign-in from a device with a live row skips the challenge; every other
-- sign-in is asked for an SMS (Firebase Phone Auth) or email code once the
-- audience is listed in MFA_ENFORCED_AUDIENCES. Only the sha256 of the device's
-- token is stored. subjectType + subjectId, like user_sessions: staff and
-- customer ids collide, so the type is part of the key.
--
-- Hand-written: `prisma migrate dev` cannot replay history into a shadow DB.
CREATE TABLE `mfa_trusted_devices` (
  `id`          INTEGER      NOT NULL AUTO_INCREMENT,
  `subjectType` VARCHAR(16)  NOT NULL,
  `subjectId`   INTEGER      NOT NULL,
  `tokenHash`   CHAR(64)     NOT NULL,
  `deviceId`    VARCHAR(80)  NULL,
  `credStamp`   CHAR(32)     NOT NULL,
  `method`      VARCHAR(8)   NOT NULL,
  `userAgent`   VARCHAR(300) NULL,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt`   DATETIME(3)  NOT NULL,
  `revokedAt`   DATETIME(3)  NULL,

  UNIQUE INDEX `mfa_trusted_devices_tokenHash_key`(`tokenHash`),
  INDEX `mfa_trusted_devices_subjectType_subjectId_idx`(`subjectType`, `subjectId`),
  INDEX `mfa_trusted_devices_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
