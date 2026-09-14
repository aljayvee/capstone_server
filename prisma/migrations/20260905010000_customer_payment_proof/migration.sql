-- The customer's own payment confirmation screenshot.
--
-- On a non-COD plan the customer pays through the company's Facebook Page and
-- has, until now, had no way to show what they sent. A dispatcher confirming a
-- payment was vouching for something they had seen in another app entirely.
--
-- The screenshot lives in errand_proof_images rather than a table of its own: it
-- is evidence about the same errand, and reusing this table means it goes
-- through the same Cloud Vision OCR, the same clarity scoring and the same
-- viewing rules as a rider's receipt. What it does NOT have is a rider — so
-- riderId becomes nullable and customerId joins it. Exactly one is set.
--
-- referenceNo is what makes a payment findable again on the Facebook Page or a
-- bank statement. An amount with no reference identifies nothing, which is why
-- the service rejects an upload that has no reference rather than storing it.
ALTER TABLE `errand_proof_images` DROP FOREIGN KEY `errand_proof_images_riderId_fkey`;

ALTER TABLE `errand_proof_images` ADD COLUMN `customerId` INTEGER NULL,
    MODIFY `riderId` INTEGER NULL,
    MODIFY `kind` ENUM('RECEIPT', 'TRANSFER', 'PROOF_OF_DELIVERY', 'NO_RECEIPT', 'PAYMENT_PROOF') NOT NULL;

ALTER TABLE `receipt_extractions` ADD COLUMN `referenceNo` VARCHAR(40) NULL,
    ADD COLUMN `transactionId` VARCHAR(40) NULL;

ALTER TABLE `errand_proof_images` ADD CONSTRAINT `errand_proof_images_riderId_fkey` FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `errand_proof_images` ADD CONSTRAINT `errand_proof_images_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
