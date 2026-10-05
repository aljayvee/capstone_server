-- Street name, landmark and rider notes for a saved delivery location, and the
-- same three copied onto each errand at creation. All nullable: every existing
-- row was a complete location without them.

-- AlterTable
ALTER TABLE `saved_delivery_locations`
    ADD COLUMN `streetName` VARCHAR(150) NULL,
    ADD COLUMN `landmark` VARCHAR(200) NULL,
    ADD COLUMN `notes` VARCHAR(300) NULL;

-- AlterTable
ALTER TABLE `errands`
    ADD COLUMN `deliveryStreetName` VARCHAR(150) NULL,
    ADD COLUMN `deliveryLandmark` VARCHAR(200) NULL,
    ADD COLUMN `deliveryNotes` VARCHAR(300) NULL;
