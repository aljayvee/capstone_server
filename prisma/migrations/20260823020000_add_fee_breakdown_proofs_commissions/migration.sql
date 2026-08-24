-- Fee breakdown, photographic proof with OCR, and rider commission snapshots.
--
-- Three problems in one migration because they share a subject — the money path
-- of an errand — and splitting them would leave the schema in states where the
-- breakdown exists but nothing records how it was split, or proofs exist with no
-- extraction to attach to.

-- ---------------------------------------------------------------------------
-- 1. Fee breakdown components on the errand.
--
-- StandardPricingStrategy has always returned these four; recalculateFee has
-- always persisted only the total and discarded them. That left the customer a
-- number with no explanation, which is why CheckoutScreen reimplemented pricing
-- client-side on a hardcoded 2.5 km and disagreed with the server.
--
-- Nullable: errands priced before this migration have no recorded breakdown, and
-- inventing one by back-computing from a rate schedule that may since have
-- changed would be a fabrication.
-- ---------------------------------------------------------------------------
ALTER TABLE `errands`
  ADD COLUMN `multiStoreFee`   DOUBLE      NULL,
  ADD COLUMN `groceryFee`      DOUBLE      NULL,
  ADD COLUMN `nonCodFee`       DOUBLE      NULL,
  ADD COLUMN `distanceFee`     DOUBLE      NULL,
  ADD COLUMN `feeCalculatedAt` DATETIME(3) NULL;

-- ---------------------------------------------------------------------------
-- 2. Attach requested items to the stop they are bought at.
--
-- Items carried only a free-text storeCategory, so "what do I buy at this store"
-- had no answer. Nullable because the customer lists items at errand creation,
-- before any store has been pinned; they attach when the dispatcher pins, and
-- unattached items stay visible as a general list.
-- ---------------------------------------------------------------------------
ALTER TABLE `pabili_item_requests_tbl`
  ADD COLUMN `pinpointId` INTEGER NULL,
  ADD INDEX `pabili_item_requests_tbl_pinpointId_idx`(`pinpointId`);

ALTER TABLE `pabili_item_requests_tbl`
  ADD CONSTRAINT `pabili_item_requests_tbl_pinpointId_fkey`
  FOREIGN KEY (`pinpointId`) REFERENCES `errand_pinpoints_tbl`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Proof images.
--
-- Base64 in LongText, matching customer_profile_photos and the store category
-- image table — the established pattern here. Clients downscale before upload so
-- a receipt is ~300 KB, well under the validator's 5 MB ceiling.
--
-- clarityScore is persisted rather than checked and thrown away: when an
-- extracted total is disputed, whether the photo was legible at all is the first
-- thing worth knowing.
-- ---------------------------------------------------------------------------
CREATE TABLE `errand_proof_images` (
  `id`             INTEGER      NOT NULL AUTO_INCREMENT,
  `errandId`       VARCHAR(191) NOT NULL,
  `pinpointId`     INTEGER      NULL,
  `riderId`        INTEGER      NOT NULL,
  `kind`           ENUM('RECEIPT', 'TRANSFER', 'PROOF_OF_DELIVERY') NOT NULL,
  `imageData`      LONGTEXT     NOT NULL,
  `mimeType`       VARCHAR(30)  NOT NULL,
  `byteSize`       INTEGER      NOT NULL,
  `clarityScore`   DOUBLE       NULL,
  `clarityVerdict` ENUM('SHARP', 'ACCEPTABLE', 'TOO_BLURRY', 'TOO_DARK') NULL,
  `capturedAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `errand_proof_images_errandId_idx`(`errandId`),
  INDEX `errand_proof_images_riderId_idx`(`riderId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `errand_proof_images`
  ADD CONSTRAINT `errand_proof_images_errandId_fkey`
  FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `errand_proof_images`
  ADD CONSTRAINT `errand_proof_images_pinpointId_fkey`
  FOREIGN KEY (`pinpointId`) REFERENCES `errand_pinpoints_tbl`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `errand_proof_images`
  ADD CONSTRAINT `errand_proof_images_riderId_fkey`
  FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. OCR extractions.
--
-- Separate from the image because OCR is retryable and re-runnable on another
-- engine, and because rawText is a second large blob almost no query wants
-- beside the picture.
--
-- extractedTotal vs confirmedTotal is the important pair: OCR proposes, the rider
-- confirms. A misread digit must never silently become what a customer is
-- charged, so both survive and any divergence stays auditable.
-- ---------------------------------------------------------------------------
CREATE TABLE `receipt_extractions` (
  `id`             INTEGER     NOT NULL AUTO_INCREMENT,
  `proofImageId`   INTEGER     NOT NULL,
  `engine`         ENUM('MLKIT', 'CLOUD_VISION') NOT NULL,
  `rawText`        LONGTEXT    NULL,
  `extractedTotal` DOUBLE      NULL,
  `extractedDate`  DATETIME(3) NULL,
  `confidence`     DOUBLE      NULL,
  `status`         ENUM('OK', 'NEEDS_REVIEW', 'FAILED') NOT NULL DEFAULT 'NEEDS_REVIEW',
  `confirmedTotal` DOUBLE      NULL,
  `confirmedAt`    DATETIME(3) NULL,
  `extractedAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `receipt_extractions_proofImageId_key`(`proofImageId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `receipt_extractions`
  ADD CONSTRAINT `receipt_extractions_proofImageId_fkey`
  FOREIGN KEY (`proofImageId`) REFERENCES `errand_proof_images`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Rider commission snapshots.
--
-- Snapshotted rather than computed on demand so a past payout cannot shift under
-- a rider when a rate is edited, and so "why was I paid this" has a stored answer
-- carrying the inputs as well as the result.
--
-- itemCostExcluded is stored precisely BECAUSE it is excluded: the company fronts
-- that money and the rider only carries it, and without recording the figure
-- there is no evidence the exclusion actually happened.
-- ---------------------------------------------------------------------------
CREATE TABLE `rider_commissions` (
  `id`               INTEGER     NOT NULL AUTO_INCREMENT,
  `errandId`         VARCHAR(191) NOT NULL,
  `riderId`          INTEGER     NOT NULL,
  `deliveryFee`      DOUBLE      NOT NULL,
  `tip`              DOUBLE      NOT NULL,
  `commissionRate`   DOUBLE      NOT NULL,
  `riderShare`       DOUBLE      NOT NULL,
  `businessShare`    DOUBLE      NOT NULL,
  `itemCostExcluded` DOUBLE      NOT NULL,
  `computedAt`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `rider_commissions_errandId_key`(`errandId`),
  INDEX `rider_commissions_riderId_idx`(`riderId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `rider_commissions`
  ADD CONSTRAINT `rider_commissions_errandId_fkey`
  FOREIGN KEY (`errandId`) REFERENCES `errands`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `rider_commissions`
  ADD CONSTRAINT `rider_commissions_riderId_fkey`
  FOREIGN KEY (`riderId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
