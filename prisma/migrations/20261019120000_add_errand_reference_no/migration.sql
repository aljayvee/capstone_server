-- Errand reference number: YYMMDD-KKKKK-NNNN (see src/lib/errandReference.ts).
-- Additive only. Existing rows stay NULL until
-- `npm run errand-ref:backfill` numbers them.

-- AlterTable
ALTER TABLE `errands` ADD COLUMN `referenceNo` VARCHAR(20) NULL;

-- CreateTable
CREATE TABLE `errand_ref_counters` (
    `day` CHAR(6) NOT NULL,
    `last` INTEGER NOT NULL,

    PRIMARY KEY (`day`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `errands_referenceNo_key` ON `errands`(`referenceNo`);
