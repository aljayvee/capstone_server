-- AlterTable
ALTER TABLE `users` ADD COLUMN `updatedBy` INTEGER NULL,
    ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_updatedBy_fkey` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
