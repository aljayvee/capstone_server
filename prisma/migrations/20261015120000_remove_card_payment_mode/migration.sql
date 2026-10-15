-- Remove the "Debit/Credit Card" payment mode (2026-10-15, on the owner's
-- instruction: "we will not do this, remove this part in the database").
--
-- It was never selectable. There is no card gateway and no Facebook Page path
-- for a card, so it sat Inactive in every customer's payment list as "Not
-- available yet" (see 20260905020000_remove_phantom_payment_mode). The app
-- lists only the modes this table holds, so deleting the row is what takes it
-- off the screen for good, and seed.ts no longer recreates it.
--
-- Guarded like the 2026-09-05 removal: if any selection or errand references
-- the row, it survives and the deploy is loud rather than destructive.
DELETE FROM `payment_modes`
WHERE `name` = 'Debit/Credit Card'
  AND NOT EXISTS (
    SELECT 1 FROM `payment_selections` WHERE `paymentModeId` = `payment_modes`.`id`
  )
  AND NOT EXISTS (
    SELECT 1 FROM `errands` WHERE `paymentModeId` = `payment_modes`.`id`
  );
