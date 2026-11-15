-- SysAdmin Permission Management & Access (PMA)
--
-- Additive only. SysAdmin accounts live in tbl_sys_admin (separate AUTO_INCREMENT
-- from users), so SysAdmin PMA tables are isolated from Owner/Dispatcher AccessGroup
-- tables to prevent ID collisions.
--
-- Secondary IT Admins start with accessGroupId = NULL, which resolves to the
-- Read-Only Monitoring baseline (5 view permissions). The Main SysAdmin (lowest
-- tbl_sys_admin.id) permanently retains full 19-capability access.

CREATE TABLE `sysadmin_access_groups` (
  `id`                  INTEGER      NOT NULL AUTO_INCREMENT,
  `name`                VARCHAR(60)  NOT NULL,
  `description`         VARCHAR(255) NULL,
  `version`             INTEGER      NOT NULL DEFAULT 1,
  `createdByActorRole`  VARCHAR(20)  NULL,
  `createdByActorId`    INTEGER      NULL,
  `updatedByActorRole`  VARCHAR(20)  NULL,
  `updatedByActorId`    INTEGER      NULL,
  `createdAt`           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`           DATETIME(3)  NOT NULL,

  UNIQUE INDEX `sysadmin_access_groups_name_key`(`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `sysadmin_access_group_permissions` (
  `groupId`       INTEGER     NOT NULL,
  `permissionKey` VARCHAR(64) NOT NULL,

  PRIMARY KEY (`groupId`, `permissionKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `sysadmin_permission_overrides` (
  `sysAdminId`          INTEGER     NOT NULL,
  `permissionKey`       VARCHAR(64) NOT NULL,
  `effect`              ENUM('GRANT', 'DENY') NOT NULL,
  `createdByActorRole`  VARCHAR(20) NULL,
  `createdByActorId`    INTEGER     NULL,
  `createdAt`           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`sysAdminId`, `permissionKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `sysadmin_pma_audit_logs` (
  `id`             INTEGER      NOT NULL AUTO_INCREMENT,
  `action`         VARCHAR(48)  NOT NULL,
  `sysAdminId`     INTEGER      NULL,
  `targetUsername` VARCHAR(100) NULL,
  `groupId`        INTEGER      NULL,
  `groupName`      VARCHAR(60)  NULL,
  `actorRole`      VARCHAR(20)  NOT NULL,
  `actorId`        INTEGER      NOT NULL,
  `actorUsername`  VARCHAR(100) NOT NULL,
  `fieldModified`  VARCHAR(64)  NOT NULL,
  `oldValue`       TEXT         NULL,
  `newValue`       TEXT         NULL,
  `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `sysadmin_pma_audit_logs_createdAt_idx`(`createdAt`),
  INDEX `sysadmin_pma_audit_logs_sysAdminId_idx`(`sysAdminId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `tbl_sys_admin` ADD COLUMN `accessGroupId` INTEGER NULL;
CREATE INDEX `tbl_sys_admin_accessGroupId_idx` ON `tbl_sys_admin`(`accessGroupId`);

ALTER TABLE `sysadmin_access_group_permissions`
  ADD CONSTRAINT `sysadmin_access_group_permissions_groupId_fkey`
  FOREIGN KEY (`groupId`) REFERENCES `sysadmin_access_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `sysadmin_permission_overrides`
  ADD CONSTRAINT `sysadmin_permission_overrides_sysAdminId_fkey`
  FOREIGN KEY (`sysAdminId`) REFERENCES `tbl_sys_admin`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `tbl_sys_admin`
  ADD CONSTRAINT `tbl_sys_admin_accessGroupId_fkey`
  FOREIGN KEY (`accessGroupId`) REFERENCES `sysadmin_access_groups`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
