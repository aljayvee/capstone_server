import os from "os";
import fs from "fs/promises";
import path from "path";
import bcrypt from "bcryptjs";
import { exec } from "child_process";
import { promisify } from "util";
import { prisma } from "../lib/prisma.js";
import { ServiceError } from "./ServiceError.js";
import { sysAdminPasswordPolicy } from "../validators/sysAdminValidators.js";
import { logger } from "../lib/logger.js";
import { sysAdminBackupService } from "./sysAdminBackupService.js";
import { sysAdminAlertService } from "./sysAdminAlertService.js";
import { eventPublisher } from "../lib/eventPublisher.js";
import { broadcastPushNotification } from "../lib/pushNotifications.js";

const execAsync = promisify(exec);

// ─── Per-Portal Maintenance State ────────────────────────────────────────────
export type PortalKey = "owner" | "dispatcher" | "rider" | "customer";
export type MaintenanceType = "SCHEDULED" | "EMERGENCY" | "UPGRADE" | "SECURITY" | "ADVISORY" | "LIVE_NOTICE";

export interface PortalMaintenanceConfig {
  portal: PortalKey;
  isActive: boolean;
  maintenanceType: MaintenanceType;
  header: string;
  message: string;
  supportContact?: string;
  customColor?: string;
  footnote?: string;
  activatedAt?: string | null;
  updatedAt: string;
}

export const DEFAULT_MAINTENANCE_HEADERS: Record<MaintenanceType, string> = {
  SCHEDULED: "Scheduled System Maintenance",
  EMERGENCY: "Emergency System Maintenance",
  UPGRADE: "Database & Infrastructure Upgrade",
  SECURITY: "Security Protocol Enforcement",
  ADVISORY: "Heads up: we edit in production",
  LIVE_NOTICE: "Heads up: we edit in production",
};

export const DEFAULT_MAINTENANCE_MESSAGES: Record<MaintenanceType, string> = {
  SCHEDULED: "Scheduled maintenance is currently underway to optimize platform reliability. Services will resume shortly.",
  EMERGENCY: "We are addressing an unexpected operational issue. System services are temporarily paused while our engineers resolve it.",
  UPGRADE: "System data structures and infrastructure components are being upgraded for enhanced performance.",
  SECURITY: "System access is temporarily restricted to enforce critical administrative security protocols.",
  ADVISORY: "If a button moves, a colour changes, or something looks different from five minutes ago, that's us. Your ride is still safe. Our code is just getting a glow-up in public.",
  LIVE_NOTICE: "If a button moves, a colour changes, or something looks different from five minutes ago, that's us. Your ride is still safe. Our code is just getting a glow-up in public.",
};

export const DEFAULT_MAINTENANCE_FOOTNOTES: Partial<Record<MaintenanceType, string>> = {
  ADVISORY: "Please enjoy the construction cones.",
  LIVE_NOTICE: "Please enjoy the construction cones.",
};

export const DEFAULT_SUPPORT_CONTACT = "support@sugo-express.org | IT Operations Desk";

const CONFIG_FILE_PATH = path.join(process.cwd(), "config", "maintenance.json");

function createDefaultPortalConfig(portal: PortalKey): PortalMaintenanceConfig {
  return {
    portal,
    isActive: false,
    maintenanceType: "SCHEDULED",
    header: DEFAULT_MAINTENANCE_HEADERS.SCHEDULED,
    message: DEFAULT_MAINTENANCE_MESSAGES.SCHEDULED,
    supportContact: DEFAULT_SUPPORT_CONTACT,
    customColor: "",
    footnote: "",
    activatedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

const maintenanceState: Record<PortalKey, PortalMaintenanceConfig> = {
  owner: createDefaultPortalConfig("owner"),
  dispatcher: createDefaultPortalConfig("dispatcher"),
  rider: createDefaultPortalConfig("rider"),
  customer: createDefaultPortalConfig("customer"),
};

let serverErrorSimulated = false;

// Whether dispatchers get the AI reason suggestions in the Help Desk (the
// "Generate suggestion" button and the Tab shortcut). A sysadmin decision for
// every dispatcher at once, so it is kept here rather than in each browser.
// Off until a sysadmin turns it on.
let dispatcherAiSuggestionsEnabled = false;

// Whether the Kuya Sugo AI Chat Companion button and drawer are visible in the Owner Portal.
// On by default; sysadmin can turn it off anytime.
let kuyaSugoEnabled = true;

async function loadMaintenanceState(): Promise<void> {
  try {
    const raw = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const portals: PortalKey[] = ["owner", "dispatcher", "rider", "customer"];
    for (const p of portals) {
      if (parsed[p]) {
        maintenanceState[p] = {
          ...createDefaultPortalConfig(p),
          ...parsed[p],
        };
      }
    }
    if (typeof parsed.serverErrorSimulated === "boolean") {
      serverErrorSimulated = parsed.serverErrorSimulated;
    }
    if (typeof parsed.dispatcherAiSuggestionsEnabled === "boolean") {
      dispatcherAiSuggestionsEnabled = parsed.dispatcherAiSuggestionsEnabled;
    }
    if (typeof parsed.kuyaSugoEnabled === "boolean") {
      kuyaSugoEnabled = parsed.kuyaSugoEnabled;
    }
    logger.info("[DevOpsService] Loaded persistent maintenance config from disk.");
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      logger.warn("[DevOpsService] Error reading maintenance config from disk, using defaults:", err);
    }
  }
}

async function saveMaintenanceState(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE_PATH,
      JSON.stringify({ ...maintenanceState, serverErrorSimulated, dispatcherAiSuggestionsEnabled, kuyaSugoEnabled }, null, 2),
      "utf-8"
    );
  } catch (err) {
    logger.error("[DevOpsService] Failed to persist maintenance state to disk:", err);
  }
}

export function getServerErrorStatus(): boolean {
  return serverErrorSimulated;
}

export async function setServerErrorStatus(
  active: boolean,
  operatorUsername?: string
): Promise<{ active: boolean }> {
  serverErrorSimulated = active;
  await saveMaintenanceState();
  logger.info(
    `[DevOpsService] 500 Server Error simulation set to ${active} by ${operatorUsername || "SysAdmin"}`
  );
  try {
    eventPublisher.emit("system:server_error_update", { active });
  } catch (err) {
    logger.warn("[DevOpsService] Failed to emit system:server_error_update:", err);
  }
  return { active };
}

export function getDispatcherAiSuggestionsEnabled(): boolean {
  return dispatcherAiSuggestionsEnabled;
}

export async function setDispatcherAiSuggestionsEnabled(
  enabled: boolean,
  operatorUsername?: string
): Promise<{ enabled: boolean }> {
  dispatcherAiSuggestionsEnabled = enabled;
  await saveMaintenanceState();
  logger.info(
    `[DevOpsService] Dispatcher AI suggestions set to ${enabled} by ${operatorUsername || "SysAdmin"}`
  );
  return { enabled };
}

export function getKuyaSugoEnabled(): boolean {
  return kuyaSugoEnabled;
}

export async function setKuyaSugoEnabled(
  enabled: boolean,
  operatorUsername?: string
): Promise<{ enabled: boolean }> {
  kuyaSugoEnabled = enabled;
  await saveMaintenanceState();
  logger.info(
    `[DevOpsService] Kuya Sugo Owner Copilot set to ${enabled} by ${operatorUsername || "SysAdmin"}`
  );
  return { enabled };
}

let initMaintenancePromise: Promise<void> | null = null;

export async function ensureMaintenanceLoaded(): Promise<void> {
  if (!initMaintenancePromise) {
    initMaintenancePromise = loadMaintenanceState();
  }
  return initMaintenancePromise;
}

// Initial load on startup
initMaintenancePromise = loadMaintenanceState();


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
  maintenance: Record<PortalKey, PortalMaintenanceConfig>;
  serverErrorSimulated: boolean;
  dispatcherAiSuggestionsEnabled: boolean;
  kuyaSugoEnabled: boolean;
}

export async function getSystemTelemetry(): Promise<SystemTelemetry> {
  await ensureMaintenanceLoaded();
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
    serverErrorSimulated: getServerErrorStatus(),
    dispatcherAiSuggestionsEnabled: getDispatcherAiSuggestionsEnabled(),
    kuyaSugoEnabled: getKuyaSugoEnabled(),
  };
}

export async function toggleMaintenanceMode(
  portal: PortalKey,
  active: boolean,
  options?: {
    maintenanceType?: MaintenanceType;
    header?: string;
    message?: string;
    supportContact?: string;
    customColor?: string;
    footnote?: string;
  },
  operatorUsername?: string
): Promise<PortalMaintenanceConfig> {
  await ensureMaintenanceLoaded();
  const current = maintenanceState[portal] || createDefaultPortalConfig(portal);
  const nowIso = new Date().toISOString();

  const type = options?.maintenanceType || current.maintenanceType || "SCHEDULED";
  const typeChanged = options?.maintenanceType !== undefined && options.maintenanceType !== current.maintenanceType;
  const isHeaderDefaultOfAnotherType = Object.entries(DEFAULT_MAINTENANCE_HEADERS).some(
    ([otherType, defaultHeader]) => otherType !== type && current.header === defaultHeader
  );
  const isMessageDefaultOfAnotherType = Object.entries(DEFAULT_MAINTENANCE_MESSAGES).some(
    ([otherType, defaultMessage]) => otherType !== type && current.message === defaultMessage
  );

  const header = options?.header?.trim() || (typeChanged || isHeaderDefaultOfAnotherType ? DEFAULT_MAINTENANCE_HEADERS[type] : (current.header || DEFAULT_MAINTENANCE_HEADERS[type]));
  const message = options?.message?.trim() || (typeChanged || isMessageDefaultOfAnotherType ? DEFAULT_MAINTENANCE_MESSAGES[type] : (current.message || DEFAULT_MAINTENANCE_MESSAGES[type]));
  const supportContact = options?.supportContact !== undefined ? options.supportContact.trim() : (current.supportContact || DEFAULT_SUPPORT_CONTACT);
  const customColor = options?.customColor !== undefined ? options.customColor.trim() : current.customColor;
  const footnote = options?.footnote !== undefined ? options.footnote.trim() : (typeChanged || !current.footnote ? (DEFAULT_MAINTENANCE_FOOTNOTES[type] || "") : current.footnote);

  maintenanceState[portal] = {
    portal,
    isActive: active,
    maintenanceType: type,
    header,
    message,
    supportContact,
    customColor,
    footnote,
    activatedAt: active ? (current.isActive && current.activatedAt ? current.activatedAt : nowIso) : null,
    updatedAt: nowIso,
  };

  await saveMaintenanceState();

  // 1. Instant Real-Time Push to all connected clients
  try {
    eventPublisher.emit("maintenance:update", maintenanceState[portal]);
  } catch (socketErr) {
    logger.warn("[DevOpsService] Failed to emit maintenance:update socket event:", socketErr);
  }

  // 2. Automated Telegram Alert Notification & Incident Log
  try {
    const isAdvisory = type === "ADVISORY" || type === "LIVE_NOTICE";
    const statusWord = active ? "ACTIVATED" : "DEACTIVATED";
    const emoji = isAdvisory ? (active ? "🚧" : "✨") : (active ? "⚠️" : "✅");
    const modeLabel = isAdvisory ? "Live Polish Notice (Non-Blocking)" : "Maintenance Mode";
    await sysAdminAlertService.sendTelegramAlert({
      alertType: "SERVICE_RESTART",
      severity: active ? (isAdvisory ? "LOW" : "HIGH") : "LOW",
      title: `${emoji} [${portal.toUpperCase()}] ${modeLabel} ${statusWord}`,
      message: `System maintenance governance was modified by <b>${operatorUsername || "Administrator"}</b>.\n\n` +
        `• <b>Portal:</b> ${portal.toUpperCase()}\n` +
        `• <b>State:</b> ${statusWord}\n` +
        `• <b>Type:</b> ${type}\n` +
        `• <b>Header:</b> ${header}\n` +
        `• <b>Notice:</b> ${message}\n` +
        (footnote ? `• <b>Footnote:</b> ${footnote}\n` : "") +
        (supportContact ? `• <b>Contact:</b> ${supportContact}\n` : "") +
        `• <b>Timestamp:</b> ${nowIso}`,
      metadata: {
        portal,
        active,
        maintenanceType: type,
        header,
        footnote,
        operator: operatorUsername,
        timestamp: nowIso,
      },
    });
  } catch (alertErr) {
    logger.warn("[DevOpsService] Failed to dispatch Telegram maintenance alert:", alertErr);
  }

  // 3. Automated FCM & Expo Mobile Push Notification Broadcast
  if (active && (portal === "customer" || portal === "rider")) {
    void dispatchMaintenancePushNotification(portal, header, message, type, footnote);
  }

  return maintenanceState[portal];
}

async function dispatchMaintenancePushNotification(
  portal: PortalKey,
  header: string,
  message: string,
  maintenanceType: MaintenanceType,
  footnote?: string
): Promise<void> {
  try {
    let tokens: (string | null)[] = [];

    if (portal === "customer") {
      const customers = await prisma.customerAccount.findMany({
        where: {
          expoPushToken: { not: null },
        },
        select: {
          expoPushToken: true,
        },
      });
      tokens = customers.map((c) => c.expoPushToken);
    } else if (portal === "rider") {
      const riders = await prisma.user.findMany({
        where: {
          role: "RIDER",
          status: "ACTIVE",
          expoPushToken: { not: null },
        },
        select: {
          expoPushToken: true,
        },
      });
      tokens = riders.map((r) => r.expoPushToken);
    }

    if (tokens.length === 0) {
      logger.info(`[DevOpsService] No push tokens found for portal '${portal}'. Skipping push broadcast.`);
      return;
    }

    const isAdvisory = maintenanceType === "ADVISORY" || maintenanceType === "LIVE_NOTICE";
    logger.info(`[DevOpsService] Broadcasting maintenance push notification to ${tokens.length} devices for portal '${portal}'...`);
    void broadcastPushNotification(tokens, {
      title: header || (isAdvisory ? "Heads up: we edit in production" : "System Under Maintenance"),
      body: message || (isAdvisory ? "Our code is getting a glow-up in public. Your errands remain completely safe." : "Scheduled system maintenance in progress. Services will resume shortly."),
      urgent: !isAdvisory,
      channelId: "default",
      data: {
        type: isAdvisory ? "LIVE_ADVISORY_NOTICE" : "MAINTENANCE_NOTICE",
        portal,
        active: "true",
        maintenanceType,
        header,
        message,
        footnote: footnote || "",
      },
    });
  } catch (pushErr) {
    logger.error(`[DevOpsService] Failed to dispatch maintenance push notifications for ${portal}:`, pushErr);
  }
}

export function getPortalMaintenanceStatus(portal: PortalKey): PortalMaintenanceConfig {
  return maintenanceState[portal] ?? createDefaultPortalConfig(portal);
}

export async function triggerDatabaseBackupSnapshot(adminId?: number): Promise<{
  success: boolean;
  backupFile: string;
  backupSizeBytes: number;
  backupSizeFormatted: string;
  timestamp: string;
}> {
  try {
    const backup = await sysAdminBackupService.createDatabaseBackup("MANUAL", adminId);
    return {
      success: true,
      backupFile: backup.fileName,
      backupSizeBytes: backup.fileSizeBytes,
      backupSizeFormatted: backup.fileSizeFormatted,
      timestamp: backup.createdAt.toISOString(),
    };
  } catch (err) {
    logger.error("[DevOpsService] Failed to trigger database backup:", err);
    throw new ServiceError(500, "Failed to create database backup snapshot.");
  }
}

export async function restartService(
  service: "backend" | "nginx",
  adminUsername: string
): Promise<{ success: boolean; message: string }> {
  if (service === "nginx") {
    if (os.platform() === "linux") {
      try {
        await execAsync("nginx -t");
        await execAsync("systemctl reload nginx");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("[DevOpsService] Nginx reload error:", err);
        throw new ServiceError(500, `Nginx reload failed: ${msg}`);
      }
    }

    sysAdminAlertService
      .sendTelegramAlert({
        alertType: "SERVICE_RESTART",
        severity: "MEDIUM",
        title: "Nginx Reverse Proxy Reloaded",
        message: `Nginx was reloaded via SysAdmin console by @${adminUsername}. Configuration syntax verified (nginx -t).`,
        metadata: { service: "nginx", triggeredBy: adminUsername },
      })
      .catch(() => {});

    return { success: true, message: "Nginx configuration verified and reloaded successfully." };
  } else if (service === "backend") {
    if (os.platform() === "linux") {
      // Small 500ms timeout ensures HTTP 200 response is sent back to the browser before process reloads
      setTimeout(() => {
        exec("pm2 restart capstone-backend", (err) => {
          if (err) logger.error("[DevOpsService] PM2 restart error:", err);
        });
      }, 500);
    }

    sysAdminAlertService
      .sendTelegramAlert({
        alertType: "SERVICE_RESTART",
        severity: "HIGH",
        title: "PM2 Backend Process Restarted",
        message: `Node.js capstone-backend process restart initiated by @${adminUsername} via SysAdmin console.`,
        metadata: { service: "backend", triggeredBy: adminUsername },
      })
      .catch(() => {});

    return {
      success: true,
      message: "PM2 backend restart initiated. Process is reloading cleanly.",
    };
  }

  throw new ServiceError(400, "Invalid service identifier. Supported: backend, nginx.");
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
  // No built-in default. There used to be one, the same for every new IT
  // administrator and committed to a public repository, so an account created
  // without a password could be signed into by anyone who had read the source.
  // The same policy the step-up schema uses decides what is strong enough.
  const passwordCheck = sysAdminPasswordPolicy.safeParse(data.password ?? "");
  if (!passwordCheck.success) {
    throw new ServiceError(
      400,
      passwordCheck.error.issues[0]?.message ?? "Set a temporary password for the new IT administrator."
    );
  }
  const rawPassword = passwordCheck.data;

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
