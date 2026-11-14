import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({
  checks: new Map<number, Record<string, any>>(),
  nextId: 1,
  incidentCalls: [] as [string, any][],
  /** Cleanup commands and result writes, in the order they happened. */
  order: [] as string[],
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    backupRestoreCheck: {
      findFirst: async () => [...h.checks.values()].filter((c) => c.status === "RUNNING").at(-1) ?? null,
      create: async ({ data }: any) => {
        const row = { id: h.nextId++, status: "RUNNING", startedAt: new Date(), ...data };
        h.checks.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        if (data.status) h.order.push(`record ${where.id} ${data.status}`);
        return Object.assign(h.checks.get(where.id)!, data);
      },
    },
  },
}));
vi.mock("../src/services/sysAdminIncidentService.js", () => ({
  sysAdminIncidentService: {
    openAutomatic: async (i: any) => (h.incidentCalls.push(["open", i]), 1),
    recoverAutomatic: async (i: any) => (h.incidentCalls.push(["recover", i]), null),
  },
}));
vi.mock("../src/services/offsiteBackupService.js", () => ({ offsiteBackupService: {} }));

import { createRestoreCheck } from "../src/services/backupRestoreCheckService.js";

const CFG = { accountId: "a", accessKeyId: "k", secretAccessKey: "s", bucket: "b", keyFile: "/root/.key" };

function harness(opts: { restoredErrands?: number; failDownload?: boolean; readyAfter?: number; configured?: boolean } = {}) {
  const calls: string[] = [];
  const alerts: any[] = [];
  let pings = 0;
  const workDir = mkdtempSync(path.join(tmpdir(), "restore-check-"));
  const svc = createRestoreCheck({
    workDir,
    sleep: async () => {},
    sendAlert: async (p) => (alerts.push(p), { alertId: 7 }),
    liveTables: async () => ["errands", "users", "customer_accounts", "tbl_sysadmin_incidents"],
    liveCount: async (t) => ({ errands: 1000, users: 40, customer_accounts: 300 }[t] ?? 0),
    offsite: {
      config: () => (opts.configured === false ? null : CFG),
      checkKeyFile: async () => {},
      latestRemote: async () => ({ key: "daily/db_backup_2026-11-15.sql.gz.gpg", sizeBytes: 1 }),
      download: async () => {
        calls.push("download");
        if (opts.failDownload) throw new Error("R2 said 403");
      },
    },
    pipe: async (a, b) => void calls.push(`pipe ${a[0]} -> ${b[1].slice(0, 3).join(" ")}`),
    run: async (cmd, args) => {
      const query = args[args.indexOf("-e") + 1] ?? "";
      calls.push(`${cmd} ${args[0]}${cmd === "docker" && args[0] === "exec" ? " " + query.slice(0, 22) : ""}`);
      if (cmd === "docker" && args[0] === "rm") h.order.push(`rm ${args[args.length - 1]}`);
      if (cmd === "docker" && args[0] === "exec") {
        if (query === "SELECT 1" && ++pings < (opts.readyAfter ?? 1)) throw new Error("not ready");
        if (query.includes("information_schema")) return { stdout: "errands\nusers\ncustomer_accounts\n", stderr: "" };
        if (query.includes("COUNT(*)")) return { stdout: `errands\t${opts.restoredErrands ?? 990}\nusers\t40\ncustomer_accounts\t300\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });
  return { svc, calls, alerts, workDir };
}

beforeEach(() => {
  h.checks.clear();
  // nextId is not reset: start() runs execute() in the background, and a run
  // left over from an earlier test must not share an id with this one.
  h.incidentCalls = [];
  h.order = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function runOne(t: ReturnType<typeof harness>) {
  const row = await (await import("../src/lib/prisma.js")).prisma.backupRestoreCheck.create({ data: { trigger: "MANUAL" } });
  await t.svc.execute(row.id);
  return h.checks.get(row.id)!;
}

describe("restore check", () => {
  it("passes end to end: download, decrypt, start, load, count, then cleans up", async () => {
    const t = harness({ readyAfter: 3 });
    const row = await runOne(t);

    expect(row).toMatchObject({ status: "PASSED", tablesRestored: 3, rowsRestored: 1330n, backupFile: "daily/db_backup_2026-11-15.sql.gz.gpg" });
    expect(row.details.keyTables.errands).toEqual({ restored: 990, live: 1000 });
    // A table created after the backup is reported, not failed.
    expect(row.details.missingTables).toEqual(["tbl_sysadmin_incidents"]);
    expect(t.calls).toEqual([
      "docker ps",
      "download",
      "gpg --batch",
      "docker run",
      "docker exec SELECT 1",
      "docker exec SELECT 1",
      "docker exec SELECT 1",
      "pipe gzip -> exec -i sugo-restore-check-1",
      "docker exec SELECT table_name FROM",
      "docker exec SELECT 'errands', COUN",
      "docker rm",
    ]);
    expect(t.alerts[0]).toMatchObject({ title: "Backup restore test passed", severity: "LOW" });
    expect(h.incidentCalls).toEqual([["recover", expect.objectContaining({ sourceKey: "BACKUP" })]]);
  });

  it("fails a restore with far fewer rows than live, with a critical alert and an incident", async () => {
    const t = harness({ restoredErrands: 10 });
    const row = await runOne(t);
    expect(row.status).toBe("FAILED");
    expect(row.error).toContain("errands has 10 rows, live has 1000");
    expect(t.alerts[0]).toMatchObject({ alertType: "BACKUP_FAILURE", severity: "CRITICAL" });
    expect(h.incidentCalls[0]).toEqual(["open", expect.objectContaining({ sourceKey: "BACKUP", severity: "CRITICAL", alertId: 7 })]);
  });

  it("records a download failure and still removes the container", async () => {
    const t = harness({ failDownload: true });
    const row = await runOne(t);
    expect(row).toMatchObject({ status: "FAILED", error: "R2 said 403" });
    expect(t.calls.at(-1)).toBe("docker rm");
    expect(t.calls).not.toContain("docker run");
  });

  it("refuses a second run while one is in progress", async () => {
    const t = harness();
    h.checks.set(99, { id: 99, status: "RUNNING", startedAt: new Date() });
    await expect(t.svc.start("MANUAL", "jay")).rejects.toMatchObject({ status: 409 });
  });

  it("marks a run stuck for over 2 hours as interrupted and starts a new one", async () => {
    const t = harness();
    h.checks.set(99, { id: 99, status: "RUNNING", startedAt: new Date(Date.now() - 3 * 3600 * 1000) });
    const row = await t.svc.start("MANUAL", "jay");
    expect(h.checks.get(99)).toMatchObject({ status: "FAILED", error: expect.stringContaining("Interrupted") });
    expect(row.id).not.toBe(99);
  });

  it("refuses to start when off-site is not configured", async () => {
    const t = harness({ configured: false });
    await expect(t.svc.start("MANUAL")).rejects.toMatchObject({ status: 409 });
  });
});

describe("restore check cleanup", () => {
  it("removes the container and the decrypted file before recording the result", async () => {
    const t = harness();
    const row = await runOne(t);
    expect(row.status).toBe("PASSED");
    // On 2026-11-15 the result was written first, and a script that exited on
    // PASSED left the container and plain customer data behind on production.
    const mine = h.order.filter((e) => e.endsWith(`-${row.id}`) || e.startsWith(`record ${row.id} `));
    expect(mine).toEqual([`rm sugo-restore-check-${row.id}`, `record ${row.id} PASSED`]);
    expect(readdirSync(t.workDir)).toEqual([]);
  });

  it("also cleans up before recording a failure", async () => {
    const t = harness({ failDownload: true });
    const row = await runOne(t);
    const mine = h.order.filter((e) => e.endsWith(`-${row.id}`) || e.startsWith(`record ${row.id} `));
    expect(mine).toEqual([`rm sugo-restore-check-${row.id}`, `record ${row.id} FAILED`]);
  });

  it("sweeps decrypted files an interrupted earlier run left behind", async () => {
    const t = harness();
    const old = path.join(t.workDir, "41");
    mkdirSync(old);
    writeFileSync(path.join(old, "backup.sql.gz"), "plain customer data");
    writeFileSync(path.join(old, "backup.sql.gz.gpg"), "x");
    await runOne(t);
    expect(existsSync(old)).toBe(false);
  });
});
