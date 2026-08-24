-- Canonicalise stored usernames and emails to lower case.
--
-- Sign-in has always matched these case-insensitively, but for usernames that
-- was never expressed in code: `users.username` and `customer_accounts.username`
-- are declared `utf8mb4_unicode_ci`, and the `_ci` suffix is what made "Jayvee"
-- find "jayvee". The application now normalises on every read and write
-- (src/lib/identity.ts), so the behaviour no longer depends on how the columns
-- happen to be collated. This migration brings existing rows into that form.
--
-- Safe to run: because the UNIQUE indexes are themselves `_ci`, the database
-- could never have held two usernames differing only by case, so lowercasing
-- cannot collide. Verified against live data before writing this (0 collisions
-- across both tables) — but the UPDATEs would fail loudly on the unique index
-- rather than corrupt anything if that assumption were ever wrong.
--
-- The collation is deliberately left as `_ci`. It is now redundant defence
-- rather than the mechanism, and tightening it to `_bin` would make sign-in
-- case-SENSITIVE, locking out anyone who signs in with different casing than
-- they registered with.

UPDATE `users`
   SET `username` = LOWER(`username`)
 WHERE `username` <> BINARY LOWER(`username`);

UPDATE `users`
   SET `email` = LOWER(`email`)
 WHERE `email` IS NOT NULL AND `email` <> BINARY LOWER(`email`);

UPDATE `customer_accounts`
   SET `username` = LOWER(`username`)
 WHERE `username` <> BINARY LOWER(`username`);

UPDATE `customer_accounts`
   SET `email` = LOWER(`email`)
 WHERE `email` IS NOT NULL AND `email` <> BINARY LOWER(`email`);
