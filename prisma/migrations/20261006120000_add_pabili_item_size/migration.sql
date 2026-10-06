-- Pabili item size, kept apart from itemName ("Chicken", "5 kg", quantity 2).
-- Additive and nullable: no backfill, existing rows keep reading as before.
-- Approved by user override of the [LOCKED] schema on 2026-10-05 (AGENT_HANDSHAKE.md).
-- Rollback: ALTER TABLE `pabili_details_tbl` DROP COLUMN `size`;
--           ALTER TABLE `pabili_item_requests_tbl` DROP COLUMN `size`;

-- AlterTable
ALTER TABLE `pabili_details_tbl` ADD COLUMN `size` VARCHAR(40) NULL;

-- AlterTable
ALTER TABLE `pabili_item_requests_tbl` ADD COLUMN `size` VARCHAR(40) NULL;
