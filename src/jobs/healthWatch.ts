/**
 * healthWatch.ts
 *
 * The API watching what it can see of itself: the database (every minute) and
 * the disk it runs on (every 15 minutes). Each is a small state machine that
 * alerts on a change of state (down, back, fuller, roomy again), never on
 * every check, so a long outage sends two messages, not one per minute.
 *
 * It cannot see the API itself being down. That is the outside monitor's job,
 * on GET /api/health/ready.
 */

import cron from "node-cron";
import { statfs } from "node:fs/promises";
import { checkReadiness } from "../lib/readiness.js";
import { logger } from "../lib/logger.js";
import { sysAdminAlertService, type AlertPayload } from "../services/sysAdminAlertService.js";
import {
  sysAdminIncidentService,
  type AutomaticIncidentInput,
  type RecoverIncidentInput,
} from "../services/sysAdminIncidentService.js";

/** Three misses in a row (about 3 minutes) before alerting: one slow query is not an outage. */
export const DB_FAILURES_BEFORE_ALERT = 3;
export const DISK_WARN_PCT = 85;
export const DISK_CRITICAL_PCT = 95;
/** Back to OK only below this, so usage hovering at 85% does not alert every 15 minutes. */
export const DISK_OK_BELOW_PCT = 80;

export type DiskLevel = "ok" | "warn" | "critical";

export interface DiskUsage {
  usedPct: number;
  freeBytes: number;
  totalBytes: number;
}

export interface HealthWatchDeps {
  checkDatabase: () => Promise<boolean>;
  readDisk: () => Promise<DiskUsage>;
  /** alertId: the recorded alert row, or null when it could not be written. */
  sendAlert: (payload: AlertPayload) => Promise<{ alertId: number | null }>;
  /** Incident records; each call never throws (sysAdminIncidentService). */
  incidents?: {
    open: (input: AutomaticIncidentInput) => Promise<unknown>;
    recover: (input: RecoverIncidentInput) => Promise<unknown>;
  };
  now?: () => number;
}

const DB_DOWN_IMPACT = "Orders, sign-ins and dispatch failed while the database did not answer.";

/** Same arithmetic as `df`: space reserved for root counts as neither used nor free. */
export async function readDiskUsage(path: string = process.cwd()): Promise<DiskUsage> {
  const s = await statfs(path);
  const used = (s.blocks - s.bfree) * s.bsize;
  const free = s.bavail * s.bsize;
  const usable = used + free;
  return {
    usedPct: usable > 0 ? (used / usable) * 100 : 0,
    freeBytes: free,
    totalBytes: s.blocks * s.bsize,
  };
}

export function nextDiskLevel(usedPct: number, previous: DiskLevel): DiskLevel {
  if (usedPct >= DISK_CRITICAL_PCT) return "critical";
  if (usedPct >= DISK_WARN_PCT) return "warn";
  // Between OK_BELOW and WARN: keep the warning until there is real room again.
  if (previous !== "ok" && usedPct >= DISK_OK_BELOW_PCT) return "warn";
  return "ok";
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export function createHealthWatch(deps: HealthWatchDeps) {
  const now = deps.now ?? Date.now;

  let dbFailures = 0;
  let dbFirstFailureAt: number | null = null;
  let dbDownAlerted = false;
  let dbDownAlertedAt: number | null = null;
  let diskLevel: DiskLevel = "ok";

  const send = (payload: AlertPayload): Promise<{ alertId: number | null }> =>
    deps.sendAlert(payload).catch((err: unknown) => {
      logger.error("[HealthWatch] Failed to send alert:", err);
      return { alertId: null };
    });

  const incidents = deps.incidents;

  async function tickDatabase(): Promise<void> {
    let ok = false;
    try {
      ok = await deps.checkDatabase();
    } catch {
      ok = false;
    }

    if (!ok) {
      dbFailures += 1;
      if (dbFirstFailureAt === null) dbFirstFailureAt = now();
      if (dbFailures === DB_FAILURES_BEFORE_ALERT && !dbDownAlerted) {
        dbDownAlerted = true;
        dbDownAlertedAt = now();
        const { alertId } = await send({
          alertType: "DB_DISCONNECT",
          severity: "CRITICAL",
          title: "Database not answering",
          message:
            `The database has failed ${DB_FAILURES_BEFORE_ALERT} checks in a row, one a minute. ` +
            "Orders, sign-ins and dispatch fail until it answers again. " +
            "Check MariaDB on the server (systemctl status mariadb).",
          metadata: { consecutiveFailures: dbFailures, firstFailureAt: new Date(dbFirstFailureAt).toISOString() },
          bypassRepeatLimit: true,
        });
        // Usually fails (the database is the thing that is down) and is
        // recorded at recovery instead; it succeeds when the DB is only slow.
        await incidents?.open({
          sourceKey: "DB_DOWN",
          title: "Database not answering",
          severity: "CRITICAL",
          startedAt: new Date(dbFirstFailureAt),
          detectedAt: new Date(dbDownAlertedAt),
          impact: DB_DOWN_IMPACT,
          alertId,
        });
      }
      return;
    }

    if (dbDownAlerted && dbFirstFailureAt !== null) {
      const downForMs = now() - dbFirstFailureAt;
      const { alertId } = await send({
        alertType: "SERVICE_RECOVERED",
        severity: "LOW",
        title: "Database answering again",
        message: `The database is back after about ${formatDuration(downForMs)} (${dbFailures} failed checks).`,
        metadata: {
          failedChecks: dbFailures,
          firstFailureAt: new Date(dbFirstFailureAt).toISOString(),
          recoveredAt: new Date(now()).toISOString(),
        },
        bypassRepeatLimit: true,
      });
      await incidents?.recover({
        sourceKey: "DB_DOWN",
        recoveredAt: new Date(now()),
        alertId,
        createIfMissing: {
          title: "Database not answering",
          severity: "CRITICAL",
          startedAt: new Date(dbFirstFailureAt),
          detectedAt: new Date(dbDownAlertedAt ?? dbFirstFailureAt),
          impact: DB_DOWN_IMPACT,
        },
      });
    }
    dbFailures = 0;
    dbFirstFailureAt = null;
    dbDownAlerted = false;
    dbDownAlertedAt = null;
  }

  async function tickDisk(): Promise<void> {
    let usage: DiskUsage;
    try {
      usage = await deps.readDisk();
    } catch (err: unknown) {
      logger.warn("[HealthWatch] Could not read disk usage:", err);
      return;
    }

    const previous = diskLevel;
    const level = nextDiskLevel(usage.usedPct, previous);
    diskLevel = level;
    if (level === previous) return;

    const pct = `${usage.usedPct.toFixed(1)}%`;
    const detail = { usedPct: Number(usage.usedPct.toFixed(1)), free: formatGb(usage.freeBytes), total: formatGb(usage.totalBytes) };

    if (level === "ok") {
      const { alertId } = await send({
        alertType: "SERVICE_RECOVERED",
        severity: "LOW",
        title: "Disk space back to normal",
        message: `The server disk is ${pct} full again, ${formatGb(usage.freeBytes)} free.`,
        metadata: detail,
        bypassRepeatLimit: true,
      });
      await incidents?.recover({ sourceKey: "DISK", recoveredAt: new Date(now()), alertId });
      return;
    }

    // Rising, or falling from critical to warn. Falling is good news, so it is quieter.
    const rising = previous === "ok" || level === "critical";
    const severity = level === "critical" ? "CRITICAL" : rising ? "HIGH" : "MEDIUM";
    const { alertId } = await send({
      alertType: "DISK_WARNING",
      severity,
      title: level === "critical" ? "Disk almost full" : rising ? "Disk filling up" : "Disk no longer critical, still high",
      message:
        `The server disk is ${pct} full, ${formatGb(usage.freeBytes)} free. ` +
        (level === "critical"
          ? "The database stops accepting writes when it is full: orders and backups will fail. "
          : "") +
        "Old backups in the backup folder and rotated logs are the usual first things to clear.",
      metadata: detail,
      bypassRepeatLimit: true,
    });
    // Joins the open disk incident when one exists (critical then back to warn).
    await incidents?.open({
      sourceKey: "DISK",
      title: "Disk filling up",
      severity,
      startedAt: new Date(now()),
      impact:
        "Nothing fails until the disk is full. Then the database stops accepting writes: orders, chat and backups fail.",
      alertId,
    });
  }

  return { tickDatabase, tickDisk };
}

export function scheduleHealthWatchJob(): void {
  const watch = createHealthWatch({
    checkDatabase: async () => (await checkReadiness()).status === "ready",
    readDisk: () => readDiskUsage(),
    sendAlert: (payload) => sysAdminAlertService.sendAlert(payload),
    incidents: {
      open: (input) => sysAdminIncidentService.openAutomatic(input),
      recover: (input) => sysAdminIncidentService.recoverAutomatic(input),
    },
  });

  cron.schedule("* * * * *", () => {
    watch.tickDatabase().catch((err) => logger.error("[HealthWatch] Database tick failed:", err));
  });
  cron.schedule("*/15 * * * *", () => {
    watch.tickDisk().catch((err) => logger.error("[HealthWatch] Disk tick failed:", err));
  });
  // Once at boot, so a server restarted onto a nearly full disk says so now, not in 15 minutes.
  watch.tickDisk().catch((err) => logger.error("[HealthWatch] Disk tick failed:", err));
}
