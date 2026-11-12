-- Access groups (RBAC) for Admin (OWNER) and Dispatcher accounts.
--
-- Additive only. users.accessGroupId starts NULL for every row, and NULL means
-- the built-in "Full access" group for the account's role (a code constant,
-- not a row), so no existing account loses or gains anything when this runs.
-- The FK is RESTRICT on purpose: deleting a group must never drop its members
-- to NULL, because NULL is full access.
--
-- Hand-written: `prisma migrate dev` cannot replay history into a shadow DB.
CREATE TABLE `access_groups` (
  `id`          INTEGER      NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(60)  NOT NULL,
  `description` VARCHAR(255) NULL,
  `scope`       ENUM('OWNER', 'DISPATCHER', 'RIDER') NOT NULL,
  `version`     INTEGER      NOT NULL DEFAULT 1,
  `createdBy`   INTEGER      NULL,
  `updatedBy`   INTEGER      NULL,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3)  NOT NULL,

  UNIQUE INDEX `access_groups_scope_name_key`(`scope`, `name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `access_group_permissions` (
  `groupId`       INTEGER     NOT NULL,
  `permissionKey` VARCHAR(64) NOT NULL,

  PRIMARY KEY (`groupId`, `permissionKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `user_permission_overrides` (
  `userId`        INTEGER     NOT NULL,
  `permissionKey` VARCHAR(64) NOT NULL,
  `effect`        ENUM('GRANT', 'DENY') NOT NULL,
  `createdBy`     INTEGER     NULL,
  `createdAt`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`userId`, `permissionKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `users` ADD COLUMN `accessGroupId` INTEGER NULL;
CREATE INDEX `users_accessGroupId_idx` ON `users`(`accessGroupId`);

ALTER TABLE `access_group_permissions`
  ADD CONSTRAINT `access_group_permissions_groupId_fkey`
  FOREIGN KEY (`groupId`) REFERENCES `access_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `user_permission_overrides`
  ADD CONSTRAINT `user_permission_overrides_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `users`
  ADD CONSTRAINT `users_accessGroupId_fkey`
  FOREIGN KEY (`accessGroupId`) REFERENCES `access_groups`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
