-- Which stop each item on the WORKING list is bought at.
--
-- pabili_item_requests_tbl already carries a pinpointId for the customer's
-- original ask. That column can only ever express the customer's own grouping,
-- because the request rows are immutable by design.
--
-- When a dispatcher splits an order across shops the customer filed under a
-- single category -- burgers and noodles both under "Fast Food & Restaurant",
-- pinned to a Jollibee and a grocery -- the split is recorded only on the
-- working copy. The rider shops from the working copy, so without this column
-- the rider's checklist showed the customer's grouping back to them and the
-- dispatcher's correction never reached the person doing the shopping.
--
-- SET NULL rather than CASCADE: re-pinning stops deletes and recreates them,
-- and that must never delete the items. They are re-attached immediately after.
ALTER TABLE `pabili_details_tbl` ADD COLUMN `pinpointId` INTEGER NULL;

CREATE INDEX `pabili_details_tbl_pinpointId_idx` ON `pabili_details_tbl`(`pinpointId`);

ALTER TABLE `pabili_details_tbl`
  ADD CONSTRAINT `pabili_details_tbl_pinpointId_fkey`
  FOREIGN KEY (`pinpointId`) REFERENCES `errand_pinpoints_tbl`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
