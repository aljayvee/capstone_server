-- Assign the intended starting fee mode to each seeded category.
--
-- The previous migration added `handlingFeeMode` with a blanket DEFAULT
-- 'THRESHOLD', which is right for a column being added to live rows but leaves
-- every category behaving identically. seedPlaces.ts carries the intended mode
-- per category, but only applies it on CREATE — deliberately, so a deploy's seed
-- run cannot silently reset a mode the owner has tuned. On an existing database
-- all four categories already exist, so that starting position never landed.
--
-- This is the one-time transition that applies it. Fresh databases get the same
-- values from the seeder's create branch.
--
-- Guarded with `handlingFeeMode = 'THRESHOLD'` so it only moves rows still at the
-- column default: if this is ever re-run after an owner has chosen a mode, their
-- choice is left alone. Retail is intentionally absent — THRESHOLD is already the
-- mode it should have.

-- A meal order is one counter transaction whatever it costs. A ₱3,500 party
-- order is not seventy times the work of a ₱50 one, so it pays a flat fee.
UPDATE `merchant_categories`
  SET `handlingFeeMode` = 'FLAT'
  WHERE `name` = 'Fast Food & Restaurant' AND `handlingFeeMode` = 'THRESHOLD';

-- Usually counter-served against a prescription: same handling either way.
UPDATE `merchant_categories`
  SET `handlingFeeMode` = 'FLAT'
  WHERE `name` = 'Pharmacy & Health' AND `handlingFeeMode` = 'THRESHOLD';

-- The case the percentage exists for. A large grocery run ties up a lot of the
-- company's cash for the duration of the errand and is a genuinely longer job,
-- so the fee scales with basket value.
UPDATE `merchant_categories`
  SET `handlingFeeMode` = 'PERCENT'
  WHERE `name` = 'Supermarket & Grocery' AND `handlingFeeMode` = 'THRESHOLD';
