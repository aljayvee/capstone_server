-- Per-item instructions for the rider ("paki pili yung walang bulok"), kept apart from itemName.
-- Additive and nullable: no backfill. Approved by user override of the [LOCKED] schema on 2026-10-06
-- (AGENT_HANDSHAKE.md), like 20261006120000_add_pabili_item_size.
-- Rollback: ALTER TABLE `pabili_details_tbl` DROP COLUMN `notes`;
--           ALTER TABLE `pabili_item_requests_tbl` DROP COLUMN `notes`;

-- AlterTable
ALTER TABLE `pabili_details_tbl` ADD COLUMN `notes` VARCHAR(200) NULL;

-- AlterTable
ALTER TABLE `pabili_item_requests_tbl` ADD COLUMN `notes` VARCHAR(200) NULL;
