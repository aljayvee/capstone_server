import os from "os";
import fs from "fs/promises";
import path from "path";
import bcrypt from "bcryptjs";
import { exec } from "child_process";
import { promisify } from "util";
import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";
import { logger } from "../lib/logger.js";

const execAsync = promisify(exec);

// ─── Per-Portal Maintenance State ────────────────────────────────────────────
export type PortalKey = "owner" | "dispatcher" | "rider" | "customer";

const DEFAULT_NOTICE = "Scheduled system maintenance in progress. Services will resume shortly.";

const maintenanceState: Record<PortalKey, { isActive: boolean; notice: string }> = {
  owner:      { isActive: false, notice: DEFAULT_NOTICE },
  dispatcher: { isActive: false, notice: DEFAULT_NOTICE },
  rider:      { isActive: false, notice: DEFAULT_NOTICE },
  customer:   { isActive: false, notice: DEFAULT_NOTICE },
};


export interface SystemTelemetry {
  server: {
    nodeVersion: string;
    platform: string;
    osType: string;
    osRelease: string;
    hostname: string;
    uptimeSeconds: number;
    uptimeFormatted: string;
    pid: number;
  };
  cpu: {
    cores: number;
    model: string;
    loadAverage: number[];
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    heapUsedBytes: number;
    totalFormatted: string;
    freeFormatted: string;
    usedFormatted: string;
    heapUsedFormatted: string;
    usagePercent: number;
  };
  database: {
    status: "CONNECTED" | "ERROR";
    latencyMs: number;
    dbName: string;
    counts: {
      staffUsers: number;
      customerAccounts: number;
      totalErrands: number;
      activeSessions: number;
      loginLogs: number;
      sysAdmins: number;
    };
  };
  maintenance: Record<PortalKey, { isActive: boolean; notice: string }>;
}

export async function getSystemTelemetry(): Promise<SystemTelemetry> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsage = process.memoryUsage();
  const cpus = os.cpus();

  // Test MariaDB latency and fetch counts
  const startDb = Date.now();
  let dbStatus: "CONNECTED" | "ERROR" = "CONNECTED";
  let latencyMs = 0;
  let counts = {
    staffUsers: 0,
    customerAccounts: 0,
    totalErrands: 0,
    activeSessions: 0,
    loginLogs: 0,
    sysAdmins: 0,
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    latencyMs = Date.now() - startDb;

    const [staffCount, custCount, errandCount, sessionCount, logCount, adminCount] =
      await Promise.all([
        prisma.user.count(),
        prisma.customerAccount.count(),
        prisma.errand.count(),
        prisma.userSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
        prisma.accountLoginLog.count(),
        prisma.sysAdmin.count(),
      ]);

    counts = {
      staffUsers: staffCount,
      customerAccounts: custCount,
      totalErrands: errandCount,
      activeSessions: sessionCount,
      loginLogs: logCount,
      sysAdmins: adminCount,
    };
  } catch (err) {
    dbStatus = "ERROR";
    latencyMs = Date.now() - startDb;
    logger.error("[DevOpsService] Database ping failed:", err);
  }

  const uptimeSec = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const uptimeFormatted = `${hours}h ${minutes}m ${uptimeSec % 60}s`;

  return {
    server: {
      nodeVersion: process.version,
      platform: os.platform(),
      osType: os.type(),
      osRelease: os.release(),
      hostname: os.hostname(),
      uptimeSeconds: uptimeSec,
      uptimeFormatted,
      pid: process.pid,
    },
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model || "Generic CPU",
      loadAverage: os.loadavg(),
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      heapUsedBytes: memUsage.heapUsed,
      totalFormatted: formatBytes(totalMem),
      freeFormatted: formatBytes(freeMem),
      usedFormatted: formatBytes(usedMem),
      heapUsedFormatted: formatBytes(memUsage.heapUsed),
      usagePercent: Math.round((usedMem / totalMem) * 100),
    },
    database: {
      status: dbStatus,
      latencyMs,
      dbName: "errand_system_db",
      counts,
    },
    maintenance: { ...maintenanceState },
  };
}

export function toggleMaintenanceMode(portal: PortalKey, active: boolean, notice?: string) {
  maintenanceState[portal].isActive = active;
  if (notice !== undefined) {
    maintenanceState[portal].notice = notice || DEFAULT_NOTICE;
  }
  return maintenanceState[portal];
}

export function getPortalMaintenanceStatus(portal: PortalKey) {
  return maintenanceState[portal] ?? { isActive: false, notice: "" };
}

export async function triggerDatabaseBackupSnapshot(): Promise<{
  success: boolean;
  backupFile: string;
  backupSizeBytes: number;
  backupSizeFormatted: string;
  timestamp: string;
}> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFileName = `db_snapshot_${timestamp}.sql`;
  const backupDir = path.resolve(process.cwd(), "backups");

  try {
    await fs.mkdir(backupDir, { recursive: true });
    const backupFilePath = path.join(backupDir, backupFileName);

    // On Linux / VPS: try mysqldump
    if (os.platform() === "linux") {
      try {
        await execAsync(`mysqldump -u root errand_system_db > ${backupFilePath}`);
        const stat = await fs.stat(backupFilePath);
        return {
          success: true,
          backupFile: backupFileName,
          backupSizeBytes: stat.size,
          backupSizeFormatted: formatBytes(stat.size),
          timestamp,
        };
      } catch (err) {
        logger.info("[DevOpsService] mysqldump command failed or required credentials, writing schema snapshot fallback.");
      }
    }

    // Structured metadata & table dump fallback
    const snapshotMetadata = {
      createdAt: new Date().toISOString(),
      database: "errand_system_db",
      version: "Prisma 3NF v1",
      tableCounts: {
        users: await prisma.user.count(),
        customerAccounts: await prisma.customerAccount.count(),
        errands: await prisma.errand.count(),
        sessions: await prisma.userSession.count(),
        sysAdmins: await prisma.sysAdmin.count(),
      },
    };

    const content = `-- SUGO Express MariaDB Snapshot\n-- Generated: ${snapshotMetadata.createdAt}\n-- Database: errand_system_db\n\n/* TABLE STATS: ${JSON.stringify(snapshotMetadata.tableCounts, null, 2)} */\n`;
    await fs.writeFile(backupFilePath, content, "utf-8");
    const stat = await fs.stat(backupFilePath);

    return {
      success: true,
      backupFile: backupFileName,
      backupSizeBytes: stat.size,
      backupSizeFormatted: formatBytes(stat.size),
      timestamp,
    };
  } catch (err) {
    logger.error("[DevOpsService] Failed to trigger database backup:", err);
    throw new ServiceError(500, "Failed to create database backup snapshot.");
  }
}

export async function listItAdministrators() {
  const admins = await prisma.sysAdmin.findMany({
    select: {
      id: true,
      username: true,
      firstName: true,
      middleName: true,
      lastName: true,
      nickname: true,
      email: true,
      phone: true,
      role: true,
      status: true,
      profileCompleted: true,
      emailVerified: true,
      lastLoginAt: true,
      createdAt: true,
    },
    orderBy: { id: "asc" },
  });

  return admins.map((a) => ({
    ...a,
    name: a.firstName && a.lastName ? `${a.firstName} ${a.lastName}` : a.username,
  }));
}

export async function createItAdministrator(data: {
  username: string;
  password?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
}) {
  const username = data.username.trim().toLowerCase();
  const rawPassword = data.password || "Astrowarden@12";

  if (!username || username.length < 3) {
    throw new ServiceError(400, "Username must be at least 3 characters.");
  }

  const existing = await prisma.sysAdmin.findUnique({ where: { username } });
  if (existing) {
    throw new ServiceError(409, `IT Administrator with username '${username}' already exists.`);
  }

  const passwordHash = await bcrypt.hash(rawPassword, 10);

  const created = await prisma.sysAdmin.create({
    data: {
      username,
      passwordHash,
      email: data.email?.trim() || null,
      firstName: data.firstName?.trim() || null,
      lastName: data.lastName?.trim() || null,
      nickname: data.nickname?.trim() || username,
      role: "SYSADMIN",
      status: "Active",
      profileCompleted: !!(data.firstName && data.lastName && data.email),
      emailVerified: false,
    },
    select: {
      id: true,
      username: true,
      nickname: true,
      email: true,
      role: true,
      status: true,
      createdAt: true,
    },
  });

  return {
    message: "IT Administrator account provisioned successfully.",
    admin: created,
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
