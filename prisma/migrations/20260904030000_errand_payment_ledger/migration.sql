-- The non-COD half-payment flow.
--
-- errand_payments is a LEDGER, not a set of columns on errands, because these
-- amounts are facts about money that arrived and must never be restated. The
-- downpayment is taken off the ESTIMATED basket before the rider buys anything,
-- and markItemsPurchased later overwrites estimatedCost with the real receipt
-- total — so a derived "half of estimatedCost" would silently change after the
-- customer had already paid it. A row cannot change under them.
--
-- confirmedByUserId is the control, not decoration: payment lands on the
-- company's Facebook Page, outside this system, so there is no gateway callback
-- to trust — only a person saying they saw it. An attestation nobody signed is a
-- figure with no one accountable for it. ON DELETE RESTRICT on that FK is
-- deliberate: a staff account cannot be removed while it still vouches for money.
--
-- overageEscalatedAt / overageResolvedAt: the receipt came in higher than the
-- customer agreed to, and the goods are held until the office arranges the
-- difference. While escalated and unresolved the rider cannot reach DELIVERED —
-- the company has fronted more than the downpayment covers, and handing the
-- goods over is the moment that becomes unrecoverable.
ALTER TABLE `errands` ADD COLUMN `overageEscalatedAt` DATETIME(3) NULL,
    ADD COLUMN `overageResolvedAt` DATETIME(3) NULL;

CREATE TABLE `errand_payments` (
    `id` VARCHAR(191) NOT NULL,
    `errandId` VARCHAR(191) NOT NULL,
    `kind` ENUM('DOWNPAYMENT', 'TOP_UP', 'FINAL', 'REFUND') NOT NULL,
    `amount` DOUBLE NOT NULL,
    `confirmedByUserId` INTEGER NOT NULL,
    `confirmedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `note` VARCHAR(255) NULL,

    INDEX `errand_payments_errandId_idx`(`errandId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `errand_payments` ADD CONSTRAINT `errand_payments_errandId_fkey` FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `errand_payments` ADD CONSTRAINT `errand_payments_confirmedByUserId_fkey` FOREIGN KEY (`confirmedByUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- The mode itself. Left to the seed's upsert in earlier environments, but a
-- deploy must not depend on a seed run to make a payment plan reachable.
--
-- Deliberately NOT one of GCash / Bank Transfer / Card: money arrives
-- out-of-band and is confirmed by a person, and activating a gateway-named mode
-- would promise an integration that does not exist.
INSERT INTO `payment_modes` (`name`, `description`, `status`, `createdAt`)
SELECT 'Non-COD — 50% Downpayment',
       'Customer pays 50% of the goods through the Facebook Page before the rider is sent; the rider collects the balance at the door.',
       'Active',
       NOW(3)
WHERE NOT EXISTS (SELECT 1 FROM `payment_modes` WHERE `name` = 'Non-COD — 50% Downpayment');
