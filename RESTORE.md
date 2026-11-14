# Restoring the database from the off-site backup

For the day the server is gone. Everything here runs on a **new** machine; it
needs nothing from the old one except what is in the password manager.

No secrets are in this file. Never add any: this repository is public.

## What you need

| Item | Where it is |
|---|---|
| The backup encryption key (one line of text) | Password manager, entry "SUGO backup encryption key" |
| R2 account id, access key id, secret access key, bucket name | Password manager, entry "SUGO R2 backups" (re-create the token in Cloudflare, R2, Manage API tokens, if lost) |
| A Linux server with MariaDB 10.11 | Any VPS. Ubuntu 24.04 ships it: `apt install mariadb-server` |

**Not in the database backup**, so keep them elsewhere too:

- the server `.env` (API keys, JWT secret, SMTP, Telegram, R2): password manager
- Firebase Realtime Database (live tracking, chat): Firebase keeps its own copy
- release APKs in `public/downloads/`: rebuild with EAS
- `config/maintenance.json`, `config/app-releases.json`: small, re-create from SysAdmin

## 1. Tools

```bash
apt update && apt install -y rclone gnupg mariadb-server
```

## 2. Point rclone at the bucket

Variables only, nothing written to disk. Fill in the four values from the password manager:

```bash
export RCLONE_CONFIG_SUGOR2_TYPE=s3
export RCLONE_CONFIG_SUGOR2_PROVIDER=Cloudflare
export RCLONE_CONFIG_SUGOR2_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
export RCLONE_CONFIG_SUGOR2_ACCESS_KEY_ID="<ACCESS_KEY_ID>"
export RCLONE_CONFIG_SUGOR2_SECRET_ACCESS_KEY="<SECRET_ACCESS_KEY>"
export RCLONE_CONFIG_SUGOR2_NO_CHECK_BUCKET=true
BUCKET="<BUCKET_NAME>"
```

## 3. Download the newest copy

```bash
rclone lsl SUGOR2:$BUCKET/daily | sort -k2,3 | tail -5     # newest last
FILE=db_backup_<timestamp>.sql.gz.gpg                       # pick the newest
rclone copyto SUGOR2:$BUCKET/daily/$FILE /root/restore/$FILE
```

Older points in time: `daily/` keeps 31 days, `monthly/` keeps one copy per month for a year.

## 4. Decrypt

Put the key in a root-only file first (paste it, then Ctrl+D):

```bash
umask 077 && cat > /root/.sugo-backup-key
gpg --batch --pinentry-mode loopback --passphrase-file /root/.sugo-backup-key \
    --decrypt --output /root/restore/db.sql.gz /root/restore/$FILE
```

`gpg: decryption failed: Bad session key` means the wrong key.

## 5. Load it

```bash
mysql -u root -e "CREATE DATABASE errand_system_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gunzip -c /root/restore/db.sql.gz | mysql -u root errand_system_db
mysql -u root errand_system_db -e "SELECT COUNT(*) FROM errands; SELECT COUNT(*) FROM users;"
```

Then deploy the server code, restore `.env`, run `npx prisma generate`, build and
start it (see the deploy notes in AGENT_HANDSHAKE.md).

## 6. Clean up

The decrypted file is every customer's personal data in plain text:

```bash
shred -u /root/restore/db.sql.gz
```

---

## First-time setup (once, on the production server)

1. **Key.** Create it, lock it down, and copy it into the password manager
   ("SUGO backup encryption key"). Without that copy, a lost server means
   unreadable backups.

   ```bash
   umask 077 && openssl rand -base64 48 > /root/.sugo-backup-key
   cat /root/.sugo-backup-key      # copy into the password manager, then clear the screen
   ```

2. **R2.** In Cloudflare: R2, Create bucket (private, no public access). Then
   R2, Manage API tokens, Create token with **Object Read & Write**, limited to
   **that bucket only**. Store all four values in the password manager
   ("SUGO R2 backups").

3. **.env.** Add to `/var/www/server/.env`, then `pm2 restart capstone-backend --update-env`:

   ```
   R2_ACCOUNT_ID=...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BACKUP_BUCKET=...
   ```

4. **Check.** SysAdmin, DevOps, Backups: Create Snapshot, wait a minute, and the
   row shows OFF-SITE. Then Test restore now; it should pass in 5 to 15 minutes.
