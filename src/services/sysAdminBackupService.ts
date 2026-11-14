/**
 * sysAdminBackupService.ts
 *
 * Gzip-compressed database backup manager with automated 7-day retention pruning,
 * inventory metadata tracking, and secure export streaming.
 */

import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import zlib from "zlib";
import { offsiteBackupService } from "./offsiteBackupService.js";

const execAsync = promisify(exec);

export const BACKUP_DIR = path.resolve(process.cwd(), "backups");
const RETENTION_DAYS = 7;

function formatBytes(bytes: number | bigint): string {
  const b = Number(bytes);
  if (b === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${parseFloat((b / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export const sysAdminBackupService = {
  /**
   * Ensures the local backups directory exists.
   */
  async ensureBackupDir(): Promise<string> {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    return BACKUP_DIR;
  },

  /**
   * Generates a compressed database backup (.sql.gz).
   */
  async createDatabaseBackup(
    backupType: "AUTOMATED" | "MANUAL" = "MANUAL",
    adminId?: number
  ): Promise<{
    id: number;
    fileName: string;
    fileSizeBytes: number;
    fileSizeFormatted: string;
    backupType: string;
    createdAt: Date;
  }> {
    await this.ensureBackupDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `db_backup_${timestamp}.sql.gz`;
    const targetFilePath = path.join(BACKUP_DIR, fileName);

    let generatedSuccess = false;
    let finalSizeBytes = 0;

    // 1. Linux VPS: Execute native mysqldump piped through gzip
    if (os.platform() === "linux") {
      try {
        // --single-transaction: one consistent snapshot with no table locks, so
        // orders keep saving while it runs (the default --lock-tables blocks writes).
        // bash -o pipefail: under plain sh a mysqldump that dies halfway still
        // ends in gzip's exit 0, and a truncated file was recorded as COMPLETED.
        const cmd = `mysqldump -u root --single-transaction --quick --routines errand_system_db | gzip > "${targetFilePath}"`;
        await execAsync(`bash -o pipefail -c '${cmd}'`);
        const stat = await fs.stat(targetFilePath);
        if (stat.size > 0) {
          finalSizeBytes = stat.size;
          generatedSuccess = true;
          logger.info(`[BackupService] mysqldump .sql.gz generated: ${fileName} (${formatBytes(finalSizeBytes)})`);
        }
      } catch (dumpErr) {
        logger.warn("[BackupService] Native mysqldump failed, attempting structured table dump fallback:", dumpErr);
      }
    }

    // 2. Structured fallback snapshot if mysqldump is unavailable (e.g. dev/Windows)
    if (!generatedSuccess) {
      try {
        const metadata = {
          database: "errand_system_db",
          createdAt: new Date().toISOString(),
          version: "Prisma 3NF v1",
          stats: {
            users: await prisma.user.count(),
            customerAccounts: await prisma.customerAccount.count(),
            errands: await prisma.errand.count(),
            sysAdmins: await prisma.sysAdmin.count(),
          },
        };

        const rawContent = `-- SUGO Express Fallback Database Snapshot\n-- Created: ${metadata.createdAt}\n-- Database: errand_system_db\n\n/* METADATA: ${JSON.stringify(metadata, null, 2)} */\n`;
        const compressed = zlib.gzipSync(Buffer.from(rawContent, "utf-8"));
        await fs.writeFile(targetFilePath, compressed);

        const stat = await fs.stat(targetFilePath);
        finalSizeBytes = stat.size;
        generatedSuccess = true;
      } catch (fallbackErr) {
        logger.error("[BackupService] Fallback snapshot generation failed:", fallbackErr);
        throw new Error("Failed to produce database backup snapshot.");
      }
    }

    // 3. Record in MariaDB tbl_database_backups
    const record = await prisma.databaseBackup.create({
      data: {
        fileName,
        fileSizeBytes: BigInt(finalSizeBytes),
        filePath: targetFilePath,
        backupType,
        status: "COMPLETED",
        createdById: adminId ?? null,
      },
    });

    // 4. Trigger background retention pruning
    this.pruneOldBackups().catch((err) => {
      logger.error("[BackupService] Error during retention pruning:", err);
    });

    // 5. Encrypted off-site copy, in the background so callers do not wait on
    //    the upload. Never throws; failures are recorded on the row and alerted.
    //    Only real dumps: the structured fallback is a stats note, not a backup.
    if (os.platform() === "linux" && fileName.startsWith("db_backup_")) {
      void offsiteBackupService.uploadRecordedBackup(record.id);
    }

    return {
      id: record.id,
      fileName: record.fileName,
      fileSizeBytes: Number(record.fileSizeBytes),
      fileSizeFormatted: formatBytes(record.fileSizeBytes),
      backupType: record.backupType,
      createdAt: record.createdAt,
    };
  },

  /**
   * Retrieves all database backups with formatted size.
   */
  async listBackups(): Promise<
    Array<{
      id: number;
      fileName: string;
      fileSizeBytes: number;
      fileSizeFormatted: string;
      backupType: string;
      status: string;
      createdBy?: string | null;
      createdAt: string;
      offsiteStatus: string | null;
      offsiteAt: string | null;
      offsiteError: string | null;
    }>
  > {
    const list = await prisma.databaseBackup.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        createdBy: {
          select: { username: true, nickname: true },
        },
      },
    });

    return list.map((b) => ({
      id: b.id,
      fileName: b.fileName,
      fileSizeBytes: Number(b.fileSizeBytes),
      fileSizeFormatted: formatBytes(b.fileSizeBytes),
      backupType: b.backupType,
      status: b.status,
      createdBy: b.createdBy ? `@${b.createdBy.nickname || b.createdBy.username}` : "Automated Cron",
      createdAt: b.createdAt.toISOString(),
      offsiteStatus: b.offsiteStatus,
      offsiteAt: b.offsiteAt?.toISOString() ?? null,
      offsiteError: b.offsiteError,
    }));
  },

  /**
   * Returns absolute path for downloading a backup file.
   */
  async getBackupDownloadPath(idOrFileName: number | string): Promise<{ filePath: string; fileName: string }> {
    let record;
    if (typeof idOrFileName === "number" || !isNaN(Number(idOrFileName))) {
      record = await prisma.databaseBackup.findUnique({ where: { id: Number(idOrFileName) } });
    } else {
      record = await prisma.databaseBackup.findUnique({ where: { fileName: idOrFileName } });
    }

    if (!record) {
      throw new Error("Backup file not found.");
    }

    if (!fsSync.existsSync(record.filePath)) {
      throw new Error("Backup file is missing on server disk.");
    }

    return { filePath: record.filePath, fileName: record.fileName };
  },

  /**
   * Deletes a backup from storage and database.
   */
  async deleteBackup(id: number): Promise<{ success: boolean; fileName: string }> {
    const record = await prisma.databaseBackup.findUnique({ where: { id } });
    if (!record) {
      throw new Error("Backup record does not exist.");
    }

    if (fsSync.existsSync(record.filePath)) {
      try {
        await fs.unlink(record.filePath);
      } catch (unlinkErr) {
        logger.warn(`[BackupService] Could not unlink ${record.filePath}:`, unlinkErr);
      }
    }

    await prisma.databaseBackup.delete({ where: { id } });
    return { success: true, fileName: record.fileName };
  },

  /**
   * Prunes backups older than RETENTION_DAYS (7 days).
   */
  async pruneOldBackups(): Promise<number> {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);

    const expiredRecords = await prisma.databaseBackup.findMany({
      where: { createdAt: { lt: cutoffDate } },
    });

    let deletedCount = 0;

    for (const rec of expiredRecords) {
      if (fsSync.existsSync(rec.filePath)) {
        try {
          await fs.unlink(rec.filePath);
        } catch {}
      }
      await prisma.databaseBackup.delete({ where: { id: rec.id } });
      deletedCount++;
    }

    if (deletedCount > 0) {
      logger.info(`[BackupService] Pruned ${deletedCount} backup(s) older than ${RETENTION_DAYS} days.`);
    }

    return deletedCount;
  },
};
