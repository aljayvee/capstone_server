-- Notification priority (LOW / NORMAL / HIGH / CRITICAL) and a link key.
-- Additive only. Hand-written: the shadow-DB replay of older history fails.
-- ENUM order is the sort order (ORDER BY priority DESC = CRITICAL first).

-- AlterTable
ALTER TABLE `notifications`
    ADD COLUMN `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'CRITICAL') NOT NULL DEFAULT 'NORMAL',
    ADD COLUMN `refKey` VARCHAR(64) NULL;

-- CreateIndex
CREATE INDEX `notifications_userId_createdAt_idx` ON `notifications`(`userId`, `createdAt`);

-- CreateIndex
CREATE INDEX `notifications_userId_type_refKey_idx` ON `notifications`(`userId`, `type`, `refKey`);

-- Backfill: the two staff types already saved that rank above NORMAL.
-- Prod data migrations have not run by themselves before; check with
-- SELECT priority, COUNT(*) FROM notifications GROUP BY priority.
UPDATE `notifications` SET `priority` = 'HIGH'
WHERE `type` IN ('RIDER_SIGNAL_LOST', 'ITEM_OUT_OF_STOCK') AND `userId` IS NOT NULL;
