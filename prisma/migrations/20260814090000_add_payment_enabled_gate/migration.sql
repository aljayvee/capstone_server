-- AlterTable
ALTER TABLE `errands` ADD COLUMN `paymentEnabledAt` DATETIME(3) NULL,
    ADD COLUMN `paymentEnabledByDispatcherId` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `errands` ADD CONSTRAINT `errands_paymentEnabledByDispatcherId_fkey` FOREIGN KEY (`paymentEnabledByDispatcherId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
