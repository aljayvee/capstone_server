-- First-login email verification for operational staff (`users`), plus the
-- one-time profile-setup gate for the seeded bootstrap admin.
--
-- `emailVerified` defaults to false so every account created from here on is
-- challenged once, on its first sign-in. `profileCompleted` defaults to true
-- because a staff account created through the dashboard already carries
-- validated names and a validated email — only the seeded `owner` row has
-- neither.

ALTER TABLE `users` ADD COLUMN `emailVerified` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `users` ADD COLUMN `emailVerifiedAt` DATETIME(3) NULL;
ALTER TABLE `users` ADD COLUMN `profileCompleted` BOOLEAN NOT NULL DEFAULT true;

-- Grandfather every account that exists at migration time. These people have
-- been signing in for months; a new gate must not lock them out.
UPDATE `users`
   SET `emailVerified` = true,
       `emailVerifiedAt` = CURRENT_TIMESTAMP(3),
       `profileCompleted` = true;

-- ...except the default bootstrap admin. Its seeded email is a placeholder on a
-- domain the allow-list rejects, so it could never receive a code. It must
-- supply a real name and email, then verify it, on its next sign-in.
UPDATE `users`
   SET `emailVerified` = false,
       `emailVerifiedAt` = NULL,
       `profileCompleted` = false
 WHERE `username` = 'owner';

-- Staff codes are keyed by userId; customerId stays for customer accounts.
ALTER TABLE `email_verification_codes` ADD COLUMN `userId` INTEGER NULL;

CREATE INDEX `email_verification_codes_userId_idx` ON `email_verification_codes`(`userId`);

ALTER TABLE `email_verification_codes`
  ADD CONSTRAINT `email_verification_codes_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
