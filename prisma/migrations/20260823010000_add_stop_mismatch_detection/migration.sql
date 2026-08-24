-- Records that a rider settled at a catalogue place other than the one pinned.
--
-- The geofence cannot see this case. Tacurong has two Jollibee branches 440 m
-- apart; if the dispatcher pins the Drive-Thru and the rider goes to the Center,
-- every breadcrumb falls outside the 75 m radius of the pinned stop. Nothing
-- errors: arrivedAt is never set, no dwell observation is written (silently
-- costing the ETA model a data point), and the ETA keeps routing to a store the
-- rider already left. The errand completes looking entirely normal.
--
-- Columns rather than a table because this is a property of one stop on one
-- errand — at most one observation per pinpoint, overwritten by nothing. The
-- pinned placeId stays untouched: what the dispatcher asked for and what the
-- rider did are both worth keeping, and comparing them is the whole point.
--
-- Nullable and unindexed on purpose. A mismatch is the rare case; every normal
-- stop leaves these NULL, and nothing queries by them yet.
ALTER TABLE `errand_pinpoints_tbl`
  ADD COLUMN `observedPlaceId`    VARCHAR(36) NULL,
  ADD COLUMN `mismatchDetectedAt` DATETIME(3) NULL;

-- SET NULL, matching the existing placeId FK: retiring a place from the
-- catalogue must not delete the errand history that referenced it.
ALTER TABLE `errand_pinpoints_tbl`
  ADD CONSTRAINT `errand_pinpoints_tbl_observedPlaceId_fkey`
  FOREIGN KEY (`observedPlaceId`) REFERENCES `verified_places`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
