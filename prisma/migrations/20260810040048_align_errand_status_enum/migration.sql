-- Defensive: coerce any row holding a dropped enum value (TRAVELING/AT_STORE/PURCHASED/EN_ROUTE/DISPUTED)
-- before narrowing the column. Confirmed via full-codebase grep that nothing ever wrote these values.
UPDATE `errands` SET `status` = 'CANCELLED' WHERE `status` NOT IN ('PENDING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE `errands` MODIFY `status` ENUM('PENDING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING';

