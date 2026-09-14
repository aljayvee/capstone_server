-- The non-COD fee tiers were the wrong way round.
--
-- The owner's rule is ₱15 on a purchase of ₱3,000 or more, and nothing below
-- it. The live configuration charged ₱50 at or above the threshold and ₱15
-- under it: every large purchase over-charged by ₱35, every smaller one charged
-- ₱15 it never owed.
--
-- The column names describe WHERE each fee applies, not how big it is, so
-- nothing about the naming caught the inversion — and the owner portal rendered
-- no inputs for these three fields at all, so nobody could see it either. Both
-- are now fixed: the portal has a Non-Cash Payment Surcharge section, and
-- rateConfigValidators refuses a save where the at-or-above fee is the smaller.
UPDATE `rate_configs` SET `nonCodFeeHigh` = 15, `nonCodFeeLow` = 0 WHERE `id` = 1;

ALTER TABLE `rate_configs`
  ALTER COLUMN `nonCodFeeHigh` SET DEFAULT 15,
  ALTER COLUMN `nonCodFeeLow` SET DEFAULT 0;
