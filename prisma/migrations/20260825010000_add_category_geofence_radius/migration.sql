-- How close a rider must be for a stop of this kind to count as reached.
--
-- The breadcrumb geofence has always used a single 75 m radius for every store.
-- That is too tight for a supermarket, whose car park alone can hold the rider
-- further from the pin than the circle reaches, and too loose for a roadside
-- carinderia, where 75 m spans the road and the shops opposite.
--
-- Defaulted to 75 so every existing category keeps behaving exactly as it did
-- until an owner deliberately changes one -- the same approach taken when
-- handlingFeeMode was added.
ALTER TABLE `merchant_categories`
  ADD COLUMN `geofenceRadiusMeters` INTEGER NOT NULL DEFAULT 75;
