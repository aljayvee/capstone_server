-- Per-device sessions backing rotating refresh tokens.
--
-- Fixes the reported "Invalid or Expired Token" on the Customer and Rider apps:
-- the access token expires in an hour and the mobile clients had no refresh
-- path, so an hour of use always ended in a forced re-login. Refresh tokens now
-- live 30 days and rotate on every use, and this table is what makes a 30-day
-- credential safe to hand a phone.
--
-- Only the SHA-256 of the current refresh token is stored, so reading this
-- table does not yield a usable credential. `previousHash`/`rotatedAt` hold the
-- immediately-preceding token for a short grace window, so a client firing
-- several requests at once does not look like a replay attack.

CREATE TABLE `user_sessions` (
  `id`            VARCHAR(36) NOT NULL,
  `subjectId`     INTEGER     NOT NULL,
  `subjectType`   VARCHAR(16) NOT NULL,
  `role`          VARCHAR(20) NOT NULL,
  `tokenHash`     CHAR(64)    NOT NULL,
  `previousHash`  CHAR(64)    NULL,
  `rotatedAt`     DATETIME(3) NULL,
  `deviceId`      VARCHAR(80) NULL,
  `userAgent`     VARCHAR(300) NULL,
  `ipAddress`     VARCHAR(64) NULL,
  `createdAt`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt`     DATETIME(3) NOT NULL,
  `revokedAt`     DATETIME(3) NULL,
  `revokedReason` VARCHAR(64) NULL,

  INDEX `user_sessions_subjectType_subjectId_idx`(`subjectType`, `subjectId`),
  INDEX `user_sessions_expiresAt_idx`(`expiresAt`),
  INDEX `user_sessions_tokenHash_idx`(`tokenHash`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- No back-fill. Refresh tokens minted before this migration carry no `sid`, so
-- they are rejected on their next use and the holder signs in once more. That
-- is a single re-login at deploy time, which is strictly better than the
-- hourly one this change removes.
