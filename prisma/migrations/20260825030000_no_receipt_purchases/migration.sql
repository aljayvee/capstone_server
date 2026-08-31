-- Purchases from shops that issue no receipt.
--
-- A sari-sari store or a market stall prints nothing. The rider photographed the
-- goods, the photo contained almost no text, and the legibility floor rejected it
-- as "too blurry to read" -- on a perfectly sharp picture. The errand then could
-- not advance at all, because the item list stayed ungated behind a receipt that
-- was never going to exist.
--
-- NO_RECEIPT skips the OCR path entirely. The amount comes from the rider and is
-- marked unverified, so it is visible as an assertion rather than passing as a
-- machine reading.
ALTER TABLE `errand_proof_images`
  MODIFY `kind` ENUM('RECEIPT', 'TRANSFER', 'PROOF_OF_DELIVERY', 'NO_RECEIPT') NOT NULL;

-- Whether a machine read this, or a person asserted it. Existing rows were all
-- read by an OCR engine, so they are verified.
ALTER TABLE `errand_proof_images`
  ADD COLUMN `verified` BOOLEAN NOT NULL DEFAULT true;

-- What the rider said they paid, where nothing existed to read.
ALTER TABLE `errand_proof_images`
  ADD COLUMN `declaredTotal` DOUBLE NULL;
