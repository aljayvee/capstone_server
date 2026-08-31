-- The cadence a device reports beaconing at.
--
-- Nullable on purpose: builds that predate the field send nothing, and those
-- rows must resolve at the idle default rather than at zero, which would mark
-- every one of them permanently signal-lost.
ALTER TABLE `rider_presence` ADD COLUMN `beaconIntervalMs` INT NULL;
