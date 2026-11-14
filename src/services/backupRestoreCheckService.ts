/**
 * backupRestoreCheckService.ts
 *
 * Proves the disaster path end to end, the way it would run on the worst day:
 *
 *   newest R2 copy --download--> .gpg --decrypt--> .sql.gz --load--> throwaway
 *   MariaDB container --> compare tables and key row counts with the live DB
 *
 * The local backup file is deliberately not used: it only proves mysqldump
 * worked. Downloading and decrypting the remote copy also proves the upload,
 * the storage and the key.
 *
 * The container is isolated from the live database, capped at 1.5 GB of
 * memory, and removed afterwards along with the decrypted file (plain customer
 * data must not linger on disk). Monthly at 03:00, or on demand from SysAdmin.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { runCommand, CommandError, type Runner } from "../lib/runCommand.js";
import { ServiceError } from "./ServiceError.js";
import { offsiteBackupService } from "./offsiteBackupService.js";
import { sysAdminAlertService, type AlertPayload } from "./sysAdminAlertService.js";
import { sysAdminIncidentService } from "./sysAdminIncidentService.js";

/** Same major version as production (MariaDB 10.11). */
export const RESTORE_IMAGE = "mariadb:10.11";
const CONTAINER_PREFIX = "sugo-restore-check-";
const STALE_RUN_MS = 2 * 60 * 60 * 1000;
const READY_TIMEOUT_MS = 180 * 1000;
/** A restore must have at least this share of the live rows in each key table. */
export const KEY_TABLE_MIN_RATIO = 0.9;
export const KEY_TABLES = ["errands", "users", "customer_accounts"] as const;
const WORK_DIR = path.resolve(process.cwd(), "backups", ".restore-check");
/** The only files a run writes: the download, then the decrypted dump. */
const WORK_FILES = ["backup.sql.gz.gpg", "backup.sql.gz"] as const;

export type Pipe = (producer: [string, string[]], consumer: [string, string[]], timeoutMs?: number) => Promise<void>;

/** producer stdout -> consumer stdin, no shell; rejects if either side fails. */
export const pipeCommands: Pipe = (producer, consumer, timeoutMs = 60 * 60 * 1000) =>
  new Promise((resolve, reject) => {
    const a = spawn(producer[0], producer[1], { stdio: ["ignore", "pipe", "pipe"] });
    const b = spawn(consumer[0], consumer[1], { stdio: ["pipe", "ignore", "pipe"] });
    let errA = "";
    let errB = "";
    let codeA: number | null | undefined;
    let codeB: number | null | undefined;
    const timer = setTimeout(() => {
      a.kill("SIGKILL");
      b.kill("SIGKILL");
    }, timeoutMs);
    a.stdout.pipe(b.stdin);
    a.stderr.on("data", (d) => (errA += d));
    b.stderr.on("data", (d) => (errB += d));
    b.stdin.on("error", () => {}); // consumer exiting early surfaces through its exit code
    const settle = () => {
      if (codeA === undefined || codeB === undefined) return;
      clearTimeout(timer);
      if (codeA !== 0) reject(new CommandError(producer[0], codeA, errA));
      else if (codeB !== 0) reject(new CommandError(consumer[0], codeB, errB));
      else resolve();
    };
    a.on("error", (e) => reject(e));
    b.on("error", (e) => reject(e));
    a.on("close", (code) => ((codeA = code), settle()));
    b.on("close", (code) => ((codeB = code), settle()));
  });

export interface RestoreDeps {
  run?: Runner;
  pipe?: Pipe;
  offsite?: Pick<typeof offsiteBackupService, "latestRemote" | "download" | "config" | "checkKeyFile">;
  liveCount?: (table: string) => Promise<number>;
  liveTables?: () => Promise<string[]>;
  sendAlert?: (payload: AlertPayload) => Promise<{ alertId: number | null }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  workDir?: string;
}

interface Step {
  name: string;
  ms: number;
}

const quoteIdent = (name: string) => "`" + name.replace(/`/g, "``") + "`";

export function createRestoreCheck(deps: RestoreDeps = {}) {
  const run = deps.run ?? runCommand;
  const pipe = deps.pipe ?? pipeCommands;
  const offsite = deps.offsite ?? offsiteBackupService;
  const sendAlert = deps.sendAlert ?? ((p: AlertPayload) => sysAdminAlertService.sendAlert(p));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const workDir = deps.workDir ?? WORK_DIR;
  const liveCount =
    deps.liveCount ??
    (async (table: string) => {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`);
      return Number(rows[0]?.n ?? 0);
    });
  const liveTables =
    deps.liveTables ??
    (async () => {
      const rows = await prisma.$queryRawUnsafe<{ t: string }[]>(
        "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'"
      );
      return rows.map((r) => r.t);
    });

  /** Starts a check in the background and returns its row. Refuses a second concurrent run. */
  async function start(trigger: "SCHEDULED" | "MANUAL", triggeredBy?: string) {
    const running = await prisma.backupRestoreCheck.findFirst({ where: { status: "RUNNING" }, orderBy: { startedAt: "desc" } });
    if (running) {
      if (now() - running.startedAt.getTime() < STALE_RUN_MS) {
        throw new ServiceError(409, "A restore test is already running. It usually takes 5 to 15 minutes.");
      }
      await prisma.backupRestoreCheck.update({
        where: { id: running.id },
        data: { status: "FAILED", finishedAt: new Date(now()), error: "Interrupted: the server restarted or the run hung for over 2 hours." },
      });
    }
    if (!offsite.config()) {
      throw new ServiceError(409, "Off-site backup is not configured yet, so there is nothing to restore from.");
    }
    const row = await prisma.backupRestoreCheck.create({ data: { trigger, triggeredBy: triggeredBy ?? null } });
    void execute(row.id);
    return row;
  }

  async function execute(id: number): Promise<void> {
    const startedMs = now();
    const steps: Step[] = [];
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t = now();
      const result = await fn();
      steps.push({ name, ms: now() - t });
      return result;
    };

    const container = `${CONTAINER_PREFIX}${id}`;
    const dir = path.join(workDir, String(id));
    const encrypted = path.join(dir, WORK_FILES[0]);
    const decrypted = path.join(dir, WORK_FILES[1]);
    const password = randomBytes(18).toString("hex");
    const sql = (query: string) =>
      run("docker", ["exec", container, "mariadb", "--protocol=TCP", "-h127.0.0.1", "-uroot", `-p${password}`, "-N", "-B", "restore_check", "-e", query]);

    let backupFile: string | null = null;
    let outcome: {
      status: "PASSED" | "FAILED";
      extra: { details: object; tablesRestored?: number; rowsRestored?: number; error?: string };
    };
    try {
      const cfg = offsite.config();
      if (!cfg) throw new Error("Off-site backup is not configured.");
      await offsite.checkKeyFile(cfg.keyFile);
      await removeLeftoverContainers();
      await removeLeftoverWorkFiles();
      await mkdir(dir, { recursive: true });

      const latest = await step("find newest off-site copy", () => offsite.latestRemote());
      if (!latest) throw new Error("No backup was found in the R2 bucket's daily/ folder.");
      backupFile = latest.key;

      await step("download from R2", () => offsite.download(latest.key, encrypted));
      await step("decrypt", () =>
        run("gpg", ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", cfg.keyFile, "--decrypt", "--output", decrypted, encrypted], {
          timeoutMs: 10 * 60 * 1000,
        })
      );

      await step("start throwaway database", async () => {
        await run("docker", ["run", "-d", "--name", container, "--memory", "1536m",
          "-e", `MARIADB_ROOT_PASSWORD=${password}`, "-e", "MARIADB_DATABASE=restore_check", RESTORE_IMAGE], { timeoutMs: 15 * 60 * 1000 });
        // TCP only answers once the real server is up: the image's init server
        // runs with networking off, so a socket ping could pass too early.
        const deadline = now() + READY_TIMEOUT_MS;
        for (;;) {
          try {
            await sql("SELECT 1");
            return;
          } catch {
            if (now() > deadline) throw new Error("The throwaway database did not start within 3 minutes.");
            await sleep(2000);
          }
        }
      });

      await step("load backup", () =>
        pipe(["gzip", ["-dc", decrypted]], ["docker", ["exec", "-i", container, "mariadb", "--protocol=TCP", "-h127.0.0.1", "-uroot", `-p${password}`, "restore_check"]])
      );

      const restoredTables = (await step("list tables", () =>
        sql("SELECT table_name FROM information_schema.tables WHERE table_schema = 'restore_check' AND table_type = 'BASE TABLE'")
      )).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (restoredTables.length === 0) throw new Error("The backup loaded but contains no tables.");

      const countsOut = (await step("count rows", () =>
        sql(restoredTables.map((t) => `SELECT '${t.replace(/'/g, "''")}', COUNT(*) FROM ${quoteIdent(t)}`).join(" UNION ALL "))
      )).stdout;
      const restoredCounts = new Map<string, number>();
      for (const line of countsOut.split("\n")) {
        const [name, n] = line.split("\t");
        if (name && n !== undefined) restoredCounts.set(name.trim(), Number(n));
      }
      const rowsRestored = [...restoredCounts.values()].reduce((a, b) => a + b, 0);

      const live = await liveTables();
      const missingTables = live.filter((t) => !restoredTables.includes(t));
      const keyTables: Record<string, { restored: number; live: number }> = {};
      const problems: string[] = [];
      for (const table of KEY_TABLES) {
        const restored = restoredCounts.get(table);
        const liveRows = await liveCount(table);
        keyTables[table] = { restored: restored ?? 0, live: liveRows };
        if (restored === undefined) problems.push(`table ${table} is missing`);
        else if (restored < Math.floor(liveRows * KEY_TABLE_MIN_RATIO)) {
          problems.push(`${table} has ${restored} rows, live has ${liveRows}`);
        }
      }
      // Tables created after the backup are expected to be missing; most of the schema is not.
      if (restoredTables.length < Math.floor(live.length * 0.9)) {
        problems.push(`only ${restoredTables.length} of ${live.length} tables restored`);
      }

      const details = { steps, keyTables, missingTables, restoredTableCount: restoredTables.length, liveTableCount: live.length };
      outcome =
        problems.length > 0
          ? { status: "FAILED", extra: { details, tablesRestored: restoredTables.length, rowsRestored, error: `Restore looks incomplete: ${problems.join("; ")}.` } }
          : { status: "PASSED", extra: { details, tablesRestored: restoredTables.length, rowsRestored } };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[RestoreCheck] #${id} failed:`, err);
      outcome = { status: "FAILED", extra: { details: { steps }, error: message } };
    }

    // Clean up BEFORE recording the result. Recording first (as on 2026-11-15)
    // let anything that stops at "PASSED" (a restart, a script) leave the
    // container and the decrypted customer data on disk.
    await run("docker", ["rm", "-f", "-v", container]).catch(() => {});
    await removeWorkFiles(dir);
    await finish(id, outcome.status, startedMs, backupFile, outcome.extra);
  }

  /** Decrypted customer data must not stay on disk. Targeted removals, no recursive delete. */
  async function removeWorkFiles(runDir: string): Promise<void> {
    for (const f of WORK_FILES) await unlink(path.join(runDir, f)).catch(() => {});
    await rmdir(runDir).catch(() => {});
  }

  /** Anything an interrupted earlier run left in workDir/<id>/. */
  async function removeLeftoverWorkFiles(): Promise<void> {
    const entries = await readdir(workDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory()) await removeWorkFiles(path.join(workDir, e.name));
  }

  /** A crash mid-run leaves a container behind; names carry the prefix, so only ours match. */
  async function removeLeftoverContainers(): Promise<void> {
    try {
      const { stdout } = await run("docker", ["ps", "-aq", "--filter", `name=${CONTAINER_PREFIX}`]);
      const ids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) await run("docker", ["rm", "-f", "-v", ...ids]);
    } catch (err: unknown) {
      logger.warn("[RestoreCheck] Could not check for leftover containers:", err);
    }
  }

  async function finish(
    id: number,
    status: "PASSED" | "FAILED",
    startedMs: number,
    backupFile: string | null,
    extra: { details: object; tablesRestored?: number; rowsRestored?: number; error?: string },
  ): Promise<void> {
    const durationMs = now() - startedMs;
    try {
      await prisma.backupRestoreCheck.update({
        where: { id },
        data: {
          status,
          backupFile,
          finishedAt: new Date(now()),
          durationMs,
          tablesRestored: extra.tablesRestored ?? null,
          rowsRestored: extra.rowsRestored === undefined ? null : BigInt(extra.rowsRestored),
          details: extra.details,
          error: extra.error ?? null,
        },
      });
    } catch (err: unknown) {
      logger.error(`[RestoreCheck] Could not record result of #${id}:`, err);
    }

    const minutes = Math.max(1, Math.round(durationMs / 60000));
    if (status === "PASSED") {
      await sendAlert({
        alertType: "TEST_ALERT",
        severity: "LOW",
        title: "Backup restore test passed",
        message: `${backupFile} was downloaded from R2, decrypted and loaded into a test database in ${minutes} min: ${extra.tablesRestored} tables, ${extra.rowsRestored} rows.`,
        metadata: { checkId: id },
        bypassRepeatLimit: true,
      }).catch(() => ({ alertId: null }));
      await sysAdminIncidentService.recoverAutomatic({ sourceKey: "BACKUP", recoveredAt: new Date(now()) });
      return;
    }

    const { alertId } = await sendAlert({
      alertType: "BACKUP_FAILURE",
      severity: "CRITICAL",
      title: "Backup restore test FAILED",
      message: `The off-site backup could not be restored: ${extra.error}. Until this passes, assume a server loss could not be recovered from R2.`,
      metadata: { checkId: id, backupFile },
      bypassRepeatLimit: true,
    }).catch(() => ({ alertId: null }));
    await sysAdminIncidentService.openAutomatic({
      sourceKey: "BACKUP",
      title: "Backup restore test failed",
      severity: "CRITICAL",
      startedAt: new Date(startedMs),
      impact: "Nothing is down, but the off-site backups could not be proven restorable.",
      alertId,
    });
  }

  return { start, execute, removeLeftoverContainers };
}

const restoreCheck = createRestoreCheck();

export const backupRestoreCheckService = {
  start: restoreCheck.start,
  /** For the monthly cron: logs instead of throwing (e.g. off-site not configured yet). */
  async run(trigger: "SCHEDULED" | "MANUAL", triggeredBy?: string): Promise<void> {
    try {
      await restoreCheck.start(trigger, triggeredBy);
    } catch (err: unknown) {
      logger.warn("[RestoreCheck] Not started:", err instanceof Error ? err.message : err);
    }
  },
};
