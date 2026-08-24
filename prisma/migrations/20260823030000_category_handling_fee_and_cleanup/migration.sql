-- Per-category handling fee mode, plus the category-list cleanup it depends on.
--
-- One migration because the pricing change is only meaningful against a clean
-- category list: leaving "test1" and "Pay Bills" active would give two of the six
-- store types a fee mode nobody intended them to have.

-- ---------------------------------------------------------------------------
-- 1. Fee mode per category.
--
-- The purchase handling fee used to depend on basket value alone, with no notion
-- of what kind of shop the rider was in — a ₱3,500 restaurant order paid a
-- "grocery fee" of ₱350. The mode belongs on the category because the category is
-- what decides it.
--
-- Defaulted to THRESHOLD, which reproduces today's behaviour exactly, so applying
-- this migration reprices nothing. The amounts stay in rate_configs; only the
-- mode is per-category, so there is still one place to edit the money.
-- ---------------------------------------------------------------------------
ALTER TABLE `merchant_categories`
  ADD COLUMN `handlingFeeMode` ENUM('THRESHOLD', 'FLAT', 'PERCENT', 'NONE') NOT NULL DEFAULT 'THRESHOLD';

-- ---------------------------------------------------------------------------
-- 2. Rename "Food & Restaurant" -> "Fast Food & Restaurant".
--
-- Order matters. pabili_item_requests_tbl.storeCategory holds the category NAME
-- as a plain string rather than a foreign key, so it does not follow the rename
-- and has to be migrated alongside it. Places and pinpoints reference the
-- category by id and are unaffected.
--
-- Guarded so a re-run, or a database where the rename already happened, is a
-- no-op rather than an error.
-- ---------------------------------------------------------------------------
UPDATE `merchant_categories`
  SET `name` = 'Fast Food & Restaurant'
  WHERE `name` = 'Food & Restaurant';

UPDATE `pabili_item_requests_tbl`
  SET `storeCategory` = 'Fast Food & Restaurant'
  WHERE `storeCategory` = 'Food & Restaurant';

-- ---------------------------------------------------------------------------
-- 3. Retire the out-of-scope and test categories.
--
-- "Pay Bills" is the live spelling of the bills-payment type this system does not
-- offer (Pabili only); its four places are already inactive and no pinpoint uses
-- it. "test1" is leftover test data with no places and no pinpoints.
--
-- Deactivated, never deleted: verified_places.categoryId is ON DELETE RESTRICT,
-- so a hard delete would fail while those rows exist, and historical errands must
-- keep resolving. Same treatment seedPlaces.ts already applies to retired types.
--
-- The 8 items whose storeCategory string reads "test1" are deliberately left
-- alone. They resolve to no active category and fall back to THRESHOLD pricing,
-- which is the behaviour they have today; rewriting a customer's recorded request
-- to a category they never chose would be worse than leaving it.
-- ---------------------------------------------------------------------------
UPDATE `merchant_categories`
  SET `status` = 'Inactive'
  WHERE `name` IN ('Pay Bills', 'Bills & Payment Centers', 'test1');

-- Anything filed under a now-retired category leaves the store picker with it.
UPDATE `verified_places`
  SET `isActive` = false
  WHERE `categoryId` IN (
    SELECT `id` FROM `merchant_categories`
    WHERE `name` IN ('Pay Bills', 'Bills & Payment Centers', 'test1')
  );
