-- Add isOnline column to account_login_logs for user presence audit tracking
ALTER TABLE `account_login_logs` ADD COLUMN `isOnline` BOOLEAN NOT NULL DEFAULT FALSE;
