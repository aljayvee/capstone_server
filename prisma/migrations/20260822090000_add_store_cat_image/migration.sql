-- Store category hero photo, one optional row per merchant category.
--
-- The owner portal's Store Categories module uploads a photo per category and
-- the CustomerApp Bento grid renders it in place of the hard-coded stock image
-- it used before. The bytes live here rather than in `merchant_categories`
-- because that table is read on every app launch and every dispatcher store
-- pick; a LongText blob inlined there would be dragged through all of it.
--
-- `categoryId` is UNIQUE so the one-photo-per-category rule is enforced by the
-- database, which is what makes the upload path a plain upsert. ON DELETE
-- CASCADE drops the photo with its category - an orphan image is unreachable.

CREATE TABLE `store_cat_image` (
  `id`         INTEGER      NOT NULL AUTO_INCREMENT,
  `categoryId` INTEGER      NOT NULL,
  `imageData`  LONGTEXT     NOT NULL,
  `mimeType`   VARCHAR(50)  NOT NULL,
  `fileSize`   INTEGER      NOT NULL,
  `fileName`   VARCHAR(255) NULL,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)  NOT NULL,

  UNIQUE INDEX `store_cat_image_categoryId_key`(`categoryId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `store_cat_image`
  ADD CONSTRAINT `store_cat_image_categoryId_fkey`
  FOREIGN KEY (`categoryId`) REFERENCES `merchant_categories`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
