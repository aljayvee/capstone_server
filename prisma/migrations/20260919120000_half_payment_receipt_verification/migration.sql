-- Half-payment (GCash/Maya) receipt verification, rider-side capture, and the
-- audit trail a report can actually join against.
--
-- Two new proof kinds: RIDER_BALANCE_PROOF is the rider's own photo of the
-- customer's GCash/Maya receipt, taken at the door and read with the same
-- reference-number/amount/same-day rigor the customer's own upload already
-- gets (see patterns/transferValidation.ts). CASH_COLLECTED is the rider's
-- photo of physical cash in hand — no OCR, the rider's typed figure is the
-- amount, exactly like NO_RECEIPT already works for a no-receipt purchase.
--
-- supersededAt replaces the old "delete the previous PAYMENT_PROOF row before
-- inserting the new one" behavior. A superseded screenshot is itself evidence
-- in a fraud dispute, and the new proofImageId FKs below need a specific row
-- to point at that a later reupload cannot silently delete out from under
-- them. NULL means "this is the current proof for its (errandId, kind)".
--
-- proofImageId on errand_payments and settlement_records links a specific
-- confirmed attestation (an UPFRONT/FINAL payment, or a cash settlement) to
-- the exact photo that justified it — there was no FK between these tables at
-- all before, only the shared errandId, which is ambiguous once an errand can
-- carry more than one historical proof. UNIQUE on both: one photo can never
-- back two different attestations, a database-level backstop on top of the
-- OCR's own same-day check.
ALTER TABLE `errand_proof_images`
    MODIFY `kind` ENUM('RECEIPT', 'TRANSFER', 'PROOF_OF_DELIVERY', 'NO_RECEIPT', 'PAYMENT_PROOF', 'RIDER_BALANCE_PROOF', 'CASH_COLLECTED') NOT NULL,
    ADD COLUMN `supersededAt` DATETIME(3) NULL;

ALTER TABLE `errand_payments` ADD COLUMN `proofImageId` INTEGER NULL;

ALTER TABLE `settlement_records` ADD COLUMN `proofImageId` INTEGER NULL;

CREATE UNIQUE INDEX `errand_payments_proofImageId_key` ON `errand_payments`(`proofImageId`);

CREATE UNIQUE INDEX `settlement_records_proofImageId_key` ON `settlement_records`(`proofImageId`);

ALTER TABLE `errand_payments` ADD CONSTRAINT `errand_payments_proofImageId_fkey` FOREIGN KEY (`proofImageId`) REFERENCES `errand_proof_images`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `settlement_records` ADD CONSTRAINT `settlement_records_proofImageId_fkey` FOREIGN KEY (`proofImageId`) REFERENCES `errand_proof_images`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
