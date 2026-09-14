-- Remove the "Non-COD — 50% Downpayment" payment mode.
--
-- It was added on a mistaken reading of the owner's rule: that the 50%
-- downpayment was a payment METHOD sitting beside GCash and Bank Transfer. It
-- is not. Nobody pays "via 50% downpayment" — they pay via GCash or a bank
-- transfer, and 50%-now-balance-later is the arrangement those channels are
-- settled under.
--
-- The row was never selected by a single customer, which is exactly what you
-- would expect of a tile naming nothing a person can hand money to. The DELETE
-- is guarded on that anyway: if any selection references it, the row survives
-- and the deploy is loud rather than destructive.
--
-- The arrangement now attaches to the real channels (see
-- services/patterns/paymentModes.isDownpaymentPlan), which is where every
-- customer who picked GCash always expected it.
DELETE FROM `payment_modes`
WHERE `name` = 'Non-COD — 50% Downpayment'
  AND NOT EXISTS (
    SELECT 1 FROM `payment_selections` WHERE `paymentModeId` = `payment_modes`.`id`
  );

-- Debit/Credit Card: no gateway, and no Facebook Page path either. There is no
-- way to actually pay by card, so offering it strands whoever picks it.
UPDATE `payment_modes` SET `status` = 'Inactive' WHERE `name` = 'Debit/Credit Card';
