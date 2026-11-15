/**
 * logRetentionService.ts
 *
 * How long each log table keeps its rows, what a cleanup would remove, and the
 * cleanup itself. Agreed with the user on 2026-11-15 (phase 2 of the audit log
 * work); the reasons per table are in POLICIES.
 *
 * Safety rules:
 * - Never prunes a table a report reads over long periods (rider login
 *   sessions and connection drops feed Rider Performance, printable by year),
 *   nor the accountability records (account changes, report prints, IT admin
 *   permission changes, incidents). Those are listed in KEPT for the panel.
 * - Runs only when a backup from the last 24 hours reached off-site storage,
 *   so every removed row stays recoverable from R2 (monthly copies kept a year).
 * - Deletes in batches, with a per-run ceiling, and records what it removed.
 * - Settings live in config/log-retention.json (no schema change); days are
 *   bounded so a typo cannot wipe a table.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "./ServiceError.js";

export const MIN_DAYS = 30;
export const MAX_DAYS = 3650;
export const BATCH_SIZE = 5000;
export const MAX_ROWS_PER_POLICY_PER_RUN = 200_000;
export const BACKUP_WINDOW_HOURS = 24;
/** Alert types that record retention and exports: accountability, so never pruned. */
export const PROTECTED_ALERT_TYPES = ["AUDIT_EXPORT", "LOG_RETENTION_RUN", "LOG_RETENTION_CHANGED"];

export type PolicyKey =
  | "rider_status_samples"
  | "notifications_read"
  | "notifications_unread"
  | "signin_logs"
  | "password_resets"
  | "ip_bans_inactive"
  | "it_alerts";

interface Policy {
  key: PolicyKey;
  label: string;
  table: string;
  defaultDays: number;
  why: string;
  /** Prisma delegate name. */
  model: "riderStatusLog" | "notification" | "accountLoginLog" | "passwordResetAttempt" | "blockedIp" | "sysAdminAlert";
  timeField: string;
  /** Extra condition beyond "older than the cutoff". */
  where: Record<string, unknown>;
}

export const POLICIES: Policy[] = [
  { key: "rider_status_samples", label: "Rider status samples", table: "rider_status_logs", defaultDays: 180, model: "riderStatusLog", timeField: "recordedAt", where: {},
    why: "One row per rider every 2 minutes; only the Rider Activity view reads them." },
  { key: "notifications_read", label: "Notifications (read)", table: "notifications", defaultDays: 90, model: "notification", timeField: "createdAt", where: { isRead: true },
    why: "The bell only needs recent ones." },
  { key: "notifications_unread", label: "Notifications (unread)", table: "notifications", defaultDays: 180, model: "notification", timeField: "createdAt", where: { isRead: false },
    why: "Nobody acts on a half-year-old unread alert." },
  { key: "signin_logs", label: "Sign-in logs", table: "account_login_logs", defaultDays: 365, model: "accountLoginLog", timeField: "createdAt", where: {},
    why: "IP addresses and devices: long enough for a security investigation, not forever." },
  { key: "password_resets", label: "Password reset attempts", table: "password_reset_attempts", defaultDays: 365, model: "passwordResetAttempt", timeField: "createdAt", where: {},
    why: "Same reasoning as sign-ins; rate limits only look at recent hours." },
  { key: "ip_bans_inactive", label: "IP bans (expired or lifted)", table: "tbl_blocked_ips", defaultDays: 180, model: "blockedIp", timeField: "updatedAt", where: { status: { in: ["EXPIRED", "REVOKED"] } },
    why: "Active bans are never touched." },
  { key: "it_alerts", label: "IT alerts", table: "tbl_sysadmin_alerts", defaultDays: 365, model: "sysAdminAlert", timeField: "createdAt",
    where: { incidentId: null, alertType: { notIn: PROTECTED_ALERT_TYPES } },
    why: "Alerts linked to an incident, and export/retention records, are kept forever." },
];

export const KEPT: { table: string; label: string; why: string }[] = [
  { table: "rider_login_sessions", label: "Rider shifts", why: "Feeds the Rider Performance report, printable by year." },
  { table: "connectivity_incidents", label: "Rider connection drops", why: "Feeds the Rider Performance report." },
  { table: "account_modification_logs", label: "Account changes", why: "Accountability: who changed what." },
  { table: "report_print_logs", label: "Report prints", why: "Accountability." },
  { table: "sysadmin_pma_audit_logs", label: "IT admin permission changes", why: "Accountability." },
  { table: "tbl_sysadmin_incidents", label: "Incidents", why: "Outage history and reports." },
  { table: "dispatch_logs", label: "Dispatch logs", why: "Part of each errand's record." },
  { table: "user_sessions", label: "Sessions", why: "Already cleaned automatically (expired or revoked over 7 days)." },
  { table: "token_blocklist", label: "Revoked tokens", why: "Already cleaned hourly once expired." },
];

export const CONFIG_FILE = path.resolve(process.cwd(), "config", "log-retention.json");
export const STATE_FILE = path.resolve(process.cwd(), "config", "log-retention-state.json");

export interface RetentionConfig {
  days: Partial<Record<PolicyKey, number>>;
  updatedBy?: string;
  updatedAt?: string;
}

export interface RunResult {
  ranAt: string;
  trigger: "SCHEDULED" | "MANUAL";
  ran: boolean;
  skippedReason: string | null;
  removed: Partial<Record<PolicyKey, number>>;
  totalRemoved: number;
  capped: PolicyKey[];
  error: string | null;
}

export function validDays(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_DAYS && v <= MAX_DAYS;
}

export function effectiveDays(cfg: RetentionConfig): Record<PolicyKey, number> {
  const out = {} as Record<PolicyKey, number>;
  for (const p of POLICIES) {
    const v = cfg.days?.[p.key];
    out[p.key] = validDays(v) ? v : p.defaultDays;
  }
  return out;
}

export function cutoffFor(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 3600_000);
}

/** The full where-clause for "rows this policy would remove". */
export function pruneWhere(policy: Policy, days: number, now: Date): Record<string, unknown> {
  return { ...policy.where, [policy.timeField]: { lt: cutoffFor(days, now) } };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export interface RetentionDeps {
  db?: typeof prisma;
  configFile?: string;
  stateFile?: string;
  now?: () => Date;
  batchSize?: number;
  maxPerPolicy?: number;
}

export function createLogRetention(deps: RetentionDeps = {}) {
  const db = deps.db ?? prisma;
  const configFile = deps.configFile ?? CONFIG_FILE;
  const stateFile = deps.stateFile ?? STATE_FILE;
  const now = deps.now ?? (() => new Date());
  const batch = deps.batchSize ?? BATCH_SIZE;
  const maxPer = deps.maxPerPolicy ?? MAX_ROWS_PER_POLICY_PER_RUN;
  const delegate = (p: Policy) => (db as unknown as Record<string, { count: Function; findMany: Function; deleteMany: Function }>)[p.model];

  const readConfig = () => readJson<RetentionConfig>(configFile, { days: {} });
  const readState = () => readJson<{ lastRun: RunResult | null }>(stateFile, { lastRun: null });

  /** A backup from the last 24 h that reached off-site storage, or the reason there is none. */
  async function backupGate(at: Date): Promise<{ ok: boolean; reason: string | null; backupId: number | null }> {
    const since = new Date(at.getTime() - BACKUP_WINDOW_HOURS * 3600_000);
    const latest = await db.databaseBackup.findFirst({
      where: { createdAt: { gte: since }, status: "COMPLETED", offsiteStatus: "UPLOADED" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (latest) return { ok: true, reason: null, backupId: latest.id };
    return { ok: false, reason: `No backup from the last ${BACKUP_WINDOW_HOURS} hours has reached off-site storage, so nothing was removed.`, backupId: null };
  }

  async function tableSizes(tables: string[]): Promise<Map<string, number>> {
    const rows = (await db.$queryRawUnsafe(
      `SELECT table_name AS t, ROUND((data_length + index_length) / 1048576, 1) AS mb FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${tables.map(() => "?").join(",")})`,
      ...tables,
    )) as { t: string; mb: unknown }[];
    return new Map(rows.map((r) => [String(r.t), Number(r.mb)]));
  }

  async function status() {
    const at = now();
    const [cfg, state] = await Promise.all([readConfig(), readState()]);
    const days = effectiveDays(cfg);
    const week = new Date(at.getTime() - 7 * 24 * 3600_000);
    const sizes = await tableSizes([...new Set([...POLICIES.map((p) => p.table), ...KEPT.map((k) => k.table)])]);

    const policies = await Promise.all(
      POLICIES.map(async (p) => {
        const d = delegate(p);
        const [rows, due, lastWeek, oldest] = await Promise.all([
          d.count({ where: p.where }),
          d.count({ where: pruneWhere(p, days[p.key], at) }),
          d.count({ where: { ...p.where, [p.timeField]: { gte: week } } }),
          d.findMany({ where: p.where, orderBy: { [p.timeField]: "asc" }, take: 1, select: { [p.timeField]: true } }),
        ]);
        const oldestAt = oldest[0]?.[p.timeField] as Date | undefined;
        return {
          key: p.key, label: p.label, table: p.table, why: p.why,
          days: days[p.key], defaultDays: p.defaultDays, cutoff: cutoffFor(days[p.key], at).toISOString(),
          rows, dueForRemoval: due, addedLast7Days: lastWeek, oldest: oldestAt ? oldestAt.toISOString() : null,
          tableSizeMb: sizes.get(p.table) ?? null,
        };
      }),
    );
    const kept = await Promise.all(
      KEPT.map(async (k) => {
        const n = (await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${k.table}\``)) as { n: unknown }[];
        return { ...k, rows: Number(n[0]?.n ?? 0), tableSizeMb: sizes.get(k.table) ?? null };
      }),
    );
    const gate = await backupGate(at);
    return {
      policies, kept, limits: { minDays: MIN_DAYS, maxDays: MAX_DAYS },
      schedule: "Every night at 03:30 Manila time, after the 02:00 backup.",
      backupGate: gate, lastRun: state.lastRun, updatedBy: cfg.updatedBy ?? null, updatedAt: cfg.updatedAt ?? null,
    };
  }

  async function updateDays(changes: Partial<Record<PolicyKey, number>>, username: string) {
    const known = new Set(POLICIES.map((p) => p.key));
    const entries = Object.entries(changes);
    if (entries.length === 0) throw new ServiceError(400, "Nothing to change.");
    for (const [k, v] of entries) {
      if (!known.has(k as PolicyKey)) throw new ServiceError(400, `Unknown log: ${k}.`);
      if (!validDays(v)) throw new ServiceError(400, `Keep between ${MIN_DAYS} and ${MAX_DAYS} days (whole days).`);
    }
    const cfg = await readConfig();
    const before = effectiveDays(cfg);
    const next: RetentionConfig = { days: { ...cfg.days, ...changes }, updatedBy: username, updatedAt: now().toISOString() };
    await writeJsonAtomic(configFile, next);
    const after = effectiveDays(next);
    const diff = POLICIES.filter((p) => before[p.key] !== after[p.key]).map((p) => `${p.label}: ${before[p.key]} -> ${after[p.key]} days`);
    if (diff.length) {
      await db.sysAdminAlert
        .create({
          data: { alertType: "LOG_RETENTION_CHANGED", severity: "MEDIUM", title: `Log retention changed by ${username}`, message: diff.join("; "), channel: "AUDIT", status: "RECORDED", metadata: { username, before, after } },
        })
        .catch(() => undefined);
    }
    return status();
  }

  let running = false;

  async function run(trigger: RunResult["trigger"]): Promise<RunResult> {
    if (running) throw new ServiceError(409, "A cleanup is already running.");
    running = true;
    try {
      return await runOnce(trigger);
    } finally {
      running = false;
    }
  }

  async function runOnce(trigger: RunResult["trigger"]): Promise<RunResult> {
    const at = now();
    const result: RunResult = { ranAt: at.toISOString(), trigger, ran: false, skippedReason: null, removed: {}, totalRemoved: 0, capped: [], error: null };
    try {
      const gate = await backupGate(at);
      if (!gate.ok) {
        result.skippedReason = gate.reason;
      } else {
        const days = effectiveDays(await readConfig());
        result.ran = true;
        for (const p of POLICIES) {
          const d = delegate(p);
          const where = pruneWhere(p, days[p.key], at);
          let removed = 0;
          while (removed < maxPer) {
            const ids = (await d.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: Math.min(batch, maxPer - removed) })) as { id: number }[];
            if (ids.length === 0) break;
            const { count } = await d.deleteMany({ where: { id: { in: ids.map((r) => r.id) } } });
            removed += count;
            if (ids.length < batch) break;
          }
          if (removed >= maxPer) result.capped.push(p.key);
          result.removed[p.key] = removed;
          result.totalRemoved += removed;
        }
      }
    } catch (err: unknown) {
      result.error = err instanceof Error ? err.message : String(err);
      logger.error("[LogRetention] Cleanup failed:", err);
    }
    await writeJsonAtomic(stateFile, { lastRun: result }).catch((e) => logger.warn("[LogRetention] Could not save the run result:", e));
    const summary = result.ran
      ? `Removed ${result.totalRemoved} old log rows: ${POLICIES.map((p) => `${p.label} ${result.removed[p.key] ?? 0}`).join(", ")}${result.capped.length ? `. Hit the per-run ceiling on: ${result.capped.join(", ")}` : ""}.`
      : result.error ? `Cleanup failed: ${result.error}` : `Skipped: ${result.skippedReason}`;
    await db.sysAdminAlert
      .create({
        data: {
          alertType: "LOG_RETENTION_RUN", severity: result.error ? "HIGH" : result.ran ? "LOW" : "MEDIUM",
          title: `Log cleanup (${trigger.toLowerCase()})${result.ran ? `: ${result.totalRemoved} rows removed` : result.error ? " failed" : " skipped"}`,
          message: summary, channel: "AUDIT", status: "RECORDED", metadata: result as unknown as object,
        },
      })
      .catch(() => undefined);
    logger.info(`[LogRetention] ${summary}`);
    return result;
  }

  return { status, updateDays, run, backupGate, readConfig };
}

export const logRetention = createLogRetention();
