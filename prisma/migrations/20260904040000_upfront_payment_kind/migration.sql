-- DOWNPAYMENT becomes UPFRONT.
--
-- GCash / PayMaya, Bank Transfer and Card are being given the same ledger the
-- 50% plan has. They are operationally identical to it — the customer pays
-- out-of-band on the Facebook Page and a dispatcher vouches that it arrived —
-- they differ only in HOW MUCH is owed before a rider goes out: half the goods
-- on the 50% plan, the whole bill on the others.
--
-- That amount is a property of the plan, not of the payment, so one kind covers
-- both and "DOWNPAYMENT" stopped being true of half the rows it would carry.
--
-- Safe as a plain rename: errand_payments is empty at the time of writing, so
-- there is no data to coerce.
ALTER TABLE `errand_payments`
  MODIFY COLUMN `kind` ENUM('UPFRONT', 'TOP_UP', 'FINAL', 'REFUND') NOT NULL;
