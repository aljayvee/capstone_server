-- Legal consent audit trail for Sugo Rider Terms of Use (RA 10173 / RA 8792).
-- Additive only: both columns default to NULL so existing riders are prompted
-- once on their next sign-in and newly created riders are prompted on first login.
ALTER TABLE `users`
  ADD COLUMN `termsAcceptedAt` DATETIME(3) NULL,
  ADD COLUMN `termsAcceptedVersion` VARCHAR(32) NULL;
