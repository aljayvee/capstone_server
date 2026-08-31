-- Why the cash came back short, in the rider's words.
--
-- The settlement already recorded a variance and a SHORT status, but nothing
-- about the cause -- and a discrepancy with no explanation is a number nobody
-- can act on. The difference between a customer who paid what they had and a
-- rider who kept the rest is exactly what this records.
--
-- Nullable and only written on a SHORT settlement; a matched one has nothing
-- to explain.
ALTER TABLE `settlement_records`
  ADD COLUMN `shortReason` VARCHAR(300) NULL;
