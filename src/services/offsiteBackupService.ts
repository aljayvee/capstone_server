/**
 * offsiteBackupService.ts
 *
 * Encrypted off-site copies of the nightly database backup, in Cloudflare R2.
 *
 *   backups/db_backup_<ts>.sql.gz  --gpg AES256-->  <file>.gpg  --rclone-->  R2 daily/<file>.gpg
 *                                                                           (+ monthly/ on the 1st)
 *
 * Why each piece:
 * - Encrypted before it leaves the server: the dump holds every customer's
 *   name, phone, address and GPS history. If the bucket or account is ever
 *   exposed, it exposes unreadable files.
 * - The key lives in a root-only file on the server AND in the maintainer's
 *   password manager. With the server gone, the off-site copies are only
 *   readable with that second copy (RESTORE.md).
 * - R2 credentials reach rclone through the child's environment, never argv,
 *   so they do not show in `ps`.
 * - Size is checked after upload; the monthly restore test proves the rest.
 *
 * Configured by R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BACKUP_BUCKET (and optionally OFFSITE_BACKUP_KEY_FILE) in the server .env.
 * With any missing, uploads are recorded as SKIPPED and nothing alerts.
 */

import { stat, unlink } from "node:fs/promises";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { runCommand, type Runner } from "../lib/runCommand.js";
import { sysAdminAlertService, type AlertPayload } from "./sysAdminAlertService.js";
import { sysAdminIncidentService } from "./sysAdminIncidentService.js";

export const OFFSITE_KEY_FILE_DEFAULT = "/root/.sugo-backup-key";
export const DAILY_KEEP_DAYS = 31;
export const MONTHLY_KEEP_DAYS = 366;
export const FRESHNESS_HOURS = 26;
const KEY_MIN_BYTES = 32;
const REMOTE = "SUGOR2";

export interface OffsiteConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  keyFile: string;
}

export function readOffsiteConfig(env: NodeJS.ProcessEnv = process.env): OffsiteConfig | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BACKUP_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, keyFile: env.OFFSITE_BACKUP_KEY_FILE?.trim() || OFFSITE_KEY_FILE_DEFAULT };
}

/** rclone reads a remote named SUGOR2 from RCLONE_CONFIG_SUGOR2_* variables. */
export function rcloneEnv(cfg: OffsiteConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    [`RCLONE_CONFIG_${REMOTE}_TYPE`]: "s3",
    [`RCLONE_CONFIG_${REMOTE}_PROVIDER`]: "Cloudflare",
    [`RCLONE_CONFIG_${REMOTE}_ACCESS_KEY_ID`]: cfg.accessKeyId,
    [`RCLONE_CONFIG_${REMOTE}_SECRET_ACCESS_KEY`]: cfg.secretAccessKey,
    [`RCLONE_CONFIG_${REMOTE}_ENDPOINT`]: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    // A token scoped to one bucket cannot list or create buckets.
    [`RCLONE_CONFIG_${REMOTE}_NO_CHECK_BUCKET`]: "true",
    [`RCLONE_CONFIG_${REMOTE}_ACL`]: "private",
  };
}

export const remotePath = (cfg: OffsiteConfig, key: string) => `${REMOTE}:${cfg.bucket}/${key}`;

export function isFirstOfMonthManila(d: Date): boolean {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", day: "numeric" }).format(d) === "1";
}

export class OffsiteNotConfiguredError extends Error {
  constructor() {
    super("Off-site backup is not configured: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY or R2_BACKUP_BUCKET is missing.");
    this.name = "OffsiteNotConfiguredError";
  }
}

export interface OffsiteDeps {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  fileSize?: (file: string) => Promise<number>;
  fileMode?: (file: string) => Promise<number>;
  removeFile?: (file: string) => Promise<void>;
  sendAlert?: (payload: AlertPayload) => Promise<{ alertId: number | null }>;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

export function createOffsiteBackup(deps: OffsiteDeps = {}) {
  const run = deps.run ?? runCommand;
  const fileSize = deps.fileSize ?? (async (f: string) => (await stat(f)).size);
  const fileMode = deps.fileMode ?? (async (f: string) => (await stat(f)).mode);
  const removeFile = deps.removeFile ?? ((f: string) => unlink(f));
  const sendAlert = deps.sendAlert ?? ((p: AlertPayload) => sysAdminAlertService.sendAlert(p));
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  const config = () => readOffsiteConfig(deps.env ?? process.env);

  /** The key file must exist, be long, and be readable by root alone. */
  async function checkKeyFile(keyFile: string): Promise<void> {
    let size: number;
    try {
      size = await fileSize(keyFile);
    } catch {
      throw new Error(`Encryption key file ${keyFile} is missing. Create it (see RESTORE.md) and keep a copy in your password manager.`);
    }
    if (size < KEY_MIN_BYTES) throw new Error(`Encryption key file ${keyFile} is too short (under ${KEY_MIN_BYTES} bytes).`);
    if (platform !== "win32" && ((await fileMode(keyFile)) & 0o077) !== 0) {
      throw new Error(`Encryption key file ${keyFile} is readable by other users. Run: chmod 600 ${keyFile}`);
    }
  }

  async function encryptAndUpload(localFile: string, fileName: string, createdAt: Date): Promise<{ key: string; sizeBytes: number }> {
    const cfg = config();
    if (!cfg) throw new OffsiteNotConfiguredError();
    await checkKeyFile(cfg.keyFile);

    const encrypted = `${localFile}.gpg`;
    const env = rcloneEnv(cfg, deps.env ?? process.env);
    try {
      await run(
        "gpg",
        ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", cfg.keyFile,
          "--symmetric", "--cipher-algo", "AES256", "--compress-algo", "none",
          "--output", encrypted, localFile],
        { timeoutMs: 10 * 60 * 1000 },
      );
      const sizeBytes = await fileSize(encrypted);
      const key = `daily/${fileName}.gpg`;

      await run("rclone", ["copyto", encrypted, remotePath(cfg, key), "--retries", "3", "--low-level-retries", "10"], {
        env,
        timeoutMs: 30 * 60 * 1000,
      });

      const listed = JSON.parse((await run("rclone", ["lsjson", remotePath(cfg, key)], { env })).stdout || "[]");
      const remoteSize = Array.isArray(listed) && listed[0] ? Number(listed[0].Size) : -1;
      if (remoteSize !== sizeBytes) {
        throw new Error(`Upload check failed: R2 has ${remoteSize} bytes for ${key}, expected ${sizeBytes}.`);
      }

      if (isFirstOfMonthManila(createdAt)) {
        await run("rclone", ["copyto", remotePath(cfg, key), remotePath(cfg, `monthly/${fileName}.gpg`)], { env });
      }
      return { key, sizeBytes };
    } finally {
      await removeFile(encrypted).catch(() => {});
    }
  }

  /** Keeps 31 days of daily copies and a year of monthly ones. Logs, never throws. */
  async function pruneRemote(): Promise<void> {
    const cfg = config();
    if (!cfg) return;
    const env = rcloneEnv(cfg, deps.env ?? process.env);
    for (const [folder, days] of [["daily", DAILY_KEEP_DAYS], ["monthly", MONTHLY_KEEP_DAYS]] as const) {
      try {
        await run("rclone", ["delete", remotePath(cfg, folder), "--min-age", `${days}d`], { env });
      } catch (err: unknown) {
        logger.warn(`[OffsiteBackup] Could not prune ${folder}/ in R2:`, err);
      }
    }
  }

  /** The newest daily copy in R2, by name (names are ISO timestamps). */
  async function latestRemote(): Promise<{ key: string; sizeBytes: number } | null> {
    const cfg = config();
    if (!cfg) throw new OffsiteNotConfiguredError();
    const env = rcloneEnv(cfg, deps.env ?? process.env);
    const listed = JSON.parse((await run("rclone", ["lsjson", remotePath(cfg, "daily")], { env })).stdout || "[]");
    const files = (Array.isArray(listed) ? listed : [])
      .filter((f: { Name?: string; IsDir?: boolean }) => !f.IsDir && typeof f.Name === "string" && f.Name.endsWith(".gpg"))
      .sort((a: { Name: string }, b: { Name: string }) => b.Name.localeCompare(a.Name));
    return files[0] ? { key: `daily/${files[0].Name}`, sizeBytes: Number(files[0].Size) } : null;
  }

  /** Downloads one object to a local path (used by the restore check). */
  async function download(key: string, target: string): Promise<void> {
    const cfg = config();
    if (!cfg) throw new OffsiteNotConfiguredError();
    await run("rclone", ["copyto", remotePath(cfg, key), target, "--retries", "3"], {
      env: rcloneEnv(cfg, deps.env ?? process.env),
      timeoutMs: 30 * 60 * 1000,
    });
  }

  /**
   * Uploads the backup recorded as `backupId` and records the outcome on its
   * row. Never throws: it runs in the background after every backup.
   */
  async function uploadRecordedBackup(backupId: number): Promise<void> {
    try {
      const record = await prisma.databaseBackup.findUnique({ where: { id: backupId } });
      if (!record) return;

      if (!config()) {
        await prisma.databaseBackup.update({
          where: { id: backupId },
          data: { offsiteStatus: "SKIPPED", offsiteError: new OffsiteNotConfiguredError().message },
        });
        return;
      }

      try {
        const { key, sizeBytes } = await encryptAndUpload(record.filePath, record.fileName, record.createdAt);
        await prisma.databaseBackup.update({
          where: { id: backupId },
          data: { offsiteStatus: "UPLOADED", offsitePath: key, offsiteSizeBytes: BigInt(sizeBytes), offsiteAt: now(), offsiteError: null },
        });
        logger.info(`[OffsiteBackup] Uploaded ${key} (${sizeBytes} bytes).`);
        await pruneRemote();
        // Closes a "no off-site copy" incident if one is open; opens nothing.
        await sysAdminIncidentService.recoverAutomatic({ sourceKey: "BACKUP", recoveredAt: now() });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[OffsiteBackup] Upload of ${record.fileName} failed:`, err);
        await prisma.databaseBackup.update({
          where: { id: backupId },
          data: { offsiteStatus: "FAILED", offsiteError: message.slice(0, 2000) },
        });
        await sendAlert({
          alertType: "BACKUP_FAILURE",
          severity: "HIGH",
          title: "Off-site backup upload failed",
          message: `Last night's database backup was made on the server but did not reach Cloudflare R2: ${message}`,
          metadata: { backupId, fileName: record.fileName },
        });
      }
    } catch (err: unknown) {
      logger.error("[OffsiteBackup] Could not record the upload outcome:", err);
    }
  }

  /**
   * Hourly. Alerts once, and opens a BACKUP incident, when no verified
   * off-site copy is newer than FRESHNESS_HOURS. Quiet until an upload has
   * at least been attempted that long ago, so turning the feature on does not
   * alert before the first night has had a chance to run. Never throws.
   */
  async function checkFreshness(): Promise<void> {
    try {
      if (!config()) return;
      const cutoff = new Date(now().getTime() - FRESHNESS_HOURS * 3600 * 1000);
      const lastUploaded = await prisma.databaseBackup.findFirst({
        where: { offsiteStatus: "UPLOADED" },
        orderBy: { offsiteAt: "desc" },
      });
      if (lastUploaded?.offsiteAt && lastUploaded.offsiteAt >= cutoff) return;

      const firstAttempt = await prisma.databaseBackup.findFirst({
        where: { offsiteStatus: { in: ["UPLOADED", "FAILED"] } },
        orderBy: { createdAt: "asc" },
      });
      if (!firstAttempt || firstAttempt.createdAt > cutoff) return;

      const open = await prisma.sysAdminIncident.findFirst({
        where: { sourceKey: "BACKUP", status: { in: ["OPEN", "MONITORING"] } },
      });
      if (open) return;

      const since = lastUploaded?.offsiteAt ? lastUploaded.offsiteAt.toISOString() : "never";
      const { alertId } = await sendAlert({
        alertType: "BACKUP_FAILURE",
        severity: "HIGH",
        title: "No off-site backup in 26 hours",
        message:
          `No database backup has reached Cloudflare R2 in ${FRESHNESS_HOURS} hours (last verified: ${since}). ` +
          "If the server were lost now, the newest restorable copy would be older than that. " +
          "Check SysAdmin, DevOps, Backups for the upload error.",
        metadata: { lastVerifiedAt: since },
        bypassRepeatLimit: true,
      });
      await sysAdminIncidentService.openAutomatic({
        sourceKey: "BACKUP",
        title: "No recent off-site backup",
        severity: "HIGH",
        startedAt: lastUploaded?.offsiteAt ?? cutoff,
        impact: "Nothing is down, but a server loss now would lose every change since the last off-site copy.",
        alertId,
      });
    } catch (err: unknown) {
      logger.error("[OffsiteBackup] Freshness check failed:", err);
    }
  }

  async function getStatus() {
    const cfg = config();
    const [lastUploaded, lastFailed, recent] = await Promise.all([
      prisma.databaseBackup.findFirst({ where: { offsiteStatus: "UPLOADED" }, orderBy: { offsiteAt: "desc" } }),
      prisma.databaseBackup.findFirst({ where: { offsiteStatus: "FAILED" }, orderBy: { createdAt: "desc" } }),
      prisma.backupRestoreCheck.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    ]);
    let keyFileOk: boolean | null = null;
    let keyFileProblem: string | null = null;
    if (cfg) {
      try {
        await checkKeyFile(cfg.keyFile);
        keyFileOk = true;
      } catch (err: unknown) {
        keyFileOk = false;
        keyFileProblem = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      configured: !!cfg,
      bucket: cfg?.bucket ?? null,
      keyFileOk,
      keyFileProblem,
      lastUploadedAt: lastUploaded?.offsiteAt?.toISOString() ?? null,
      lastUploadedFile: lastUploaded?.offsitePath ?? null,
      lastFailedAt: lastFailed?.createdAt.toISOString() ?? null,
      lastError: lastFailed?.offsiteError ?? null,
      restoreChecks: recent.map((c) => ({
        ...c,
        rowsRestored: c.rowsRestored === null ? null : Number(c.rowsRestored),
        startedAt: c.startedAt.toISOString(),
        finishedAt: c.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  return { encryptAndUpload, pruneRemote, latestRemote, download, uploadRecordedBackup, checkFreshness, getStatus, checkKeyFile, config };
}

export const offsiteBackupService = createOffsiteBackup();
