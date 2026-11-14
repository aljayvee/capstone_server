import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const h = vi.hoisted(() => ({
  backups: new Map<number, Record<string, any>>(),
  openIncident: null as null | Record<string, any>,
  incidentCalls: [] as [string, any][],
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    databaseBackup: {
      findUnique: async ({ where }: any) => h.backups.get(where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(h.backups.get(where.id)!, data),
      findFirst: async ({ where, orderBy }: any) => {
        let rows = [...h.backups.values()];
        if (where?.offsiteStatus?.in) rows = rows.filter((r) => where.offsiteStatus.in.includes(r.offsiteStatus));
        else if (where?.offsiteStatus) rows = rows.filter((r) => r.offsiteStatus === where.offsiteStatus);
        const key = Object.keys(orderBy)[0];
        const dir = orderBy[key] === "asc" ? 1 : -1;
        rows.sort((a, b) => dir * ((a[key]?.getTime?.() ?? 0) - (b[key]?.getTime?.() ?? 0)));
        return rows[0] ?? null;
      },
    },
    sysAdminIncident: { findFirst: async () => h.openIncident },
    backupRestoreCheck: { findMany: async () => [] },
  },
}));
vi.mock("../src/services/sysAdminIncidentService.js", () => ({
  sysAdminIncidentService: {
    openAutomatic: async (i: any) => (h.incidentCalls.push(["open", i]), 1),
    recoverAutomatic: async (i: any) => (h.incidentCalls.push(["recover", i]), null),
  },
}));

import { runCommand } from "../src/lib/runCommand.js";
import {
  createOffsiteBackup,
  readOffsiteConfig,
  isFirstOfMonthManila,
  FRESHNESS_HOURS,
} from "../src/services/offsiteBackupService.js";

const ENV = {
  R2_ACCOUNT_ID: "acct123",
  R2_ACCESS_KEY_ID: "AKID-test",
  R2_SECRET_ACCESS_KEY: "super-secret-value",
  R2_BACKUP_BUCKET: "sugo-backups",
  OFFSITE_BACKUP_KEY_FILE: "/root/.key",
};
const NOW = new Date("2026-11-15T18:00:00Z"); // 02:00 on the 16th in Manila

function harness(opts: { remoteSize?: number; failOn?: string; env?: Record<string, string>; keyMode?: number } = {}) {
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const removed: string[] = [];
  const alerts: any[] = [];
  const svc = createOffsiteBackup({
    env: (opts.env ?? ENV) as NodeJS.ProcessEnv,
    platform: "linux",
    now: () => NOW,
    fileSize: async (f) => (f.endsWith(".key") ? 64 : 1000),
    fileMode: async () => opts.keyMode ?? 0o100600,
    removeFile: async (f) => void removed.push(f),
    sendAlert: async (p) => (alerts.push(p), { alertId: 9 }),
    run: async (cmd, args, o) => {
      calls.push({ cmd, args, env: o?.env });
      if (opts.failOn && `${cmd} ${args[0]}` === opts.failOn) throw new Error(`${opts.failOn} exploded`);
      if (cmd === "rclone" && args[0] === "lsjson") return { stdout: JSON.stringify([{ Name: "x.gpg", Size: opts.remoteSize ?? 1000 }]), stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });
  return { svc, calls, removed, alerts };
}

beforeEach(() => {
  h.backups.clear();
  h.openIncident = null;
  h.incidentCalls = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("config", () => {
  it("needs all four R2 settings and defaults the key file", () => {
    expect(readOffsiteConfig({ ...ENV, R2_BACKUP_BUCKET: "" } as any)).toBeNull();
    const { OFFSITE_BACKUP_KEY_FILE: _, ...noKey } = ENV;
    expect(readOffsiteConfig(noKey as any)?.keyFile).toBe("/root/.sugo-backup-key");
  });

  it("knows the first of the month in Manila, not UTC", () => {
    expect(isFirstOfMonthManila(new Date("2026-11-30T17:00:00Z"))).toBe(true); // 01:00 Dec 1 Manila
    expect(isFirstOfMonthManila(new Date("2026-12-01T17:00:00Z"))).toBe(false); // 01:00 Dec 2 Manila
  });
});

describe("encryptAndUpload", () => {
  it("encrypts, uploads, verifies size, and removes the encrypted temp file", async () => {
    const t = harness();
    const out = await t.svc.encryptAndUpload("/b/db_backup_x.sql.gz", "db_backup_x.sql.gz", NOW);
    expect(out).toEqual({ key: "daily/db_backup_x.sql.gz.gpg", sizeBytes: 1000 });
    expect(t.calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(["gpg --batch", "rclone copyto", "rclone lsjson"]);
    expect(t.calls[0].args).toEqual(expect.arrayContaining(["--symmetric", "--cipher-algo", "AES256", "--passphrase-file", "/root/.key"]));
    expect(t.calls[1].args.slice(1, 3)).toEqual(["/b/db_backup_x.sql.gz.gpg", "SUGOR2:sugo-backups/daily/db_backup_x.sql.gz.gpg"]);
    expect(t.removed).toEqual(["/b/db_backup_x.sql.gz.gpg"]);
  });

  it("passes R2 secrets only through the environment, never as arguments", async () => {
    const t = harness();
    await t.svc.encryptAndUpload("/b/f.sql.gz", "f.sql.gz", NOW);
    for (const c of t.calls) expect(c.args.join(" ")).not.toContain("super-secret-value");
    const rclone = t.calls.find((c) => c.cmd === "rclone")!;
    expect(rclone.env).toMatchObject({
      RCLONE_CONFIG_SUGOR2_SECRET_ACCESS_KEY: "super-secret-value",
      RCLONE_CONFIG_SUGOR2_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
      RCLONE_CONFIG_SUGOR2_NO_CHECK_BUCKET: "true",
    });
  });

  it("also keeps a monthly copy on the 1st (Manila)", async () => {
    const t = harness();
    await t.svc.encryptAndUpload("/b/f.sql.gz", "f.sql.gz", new Date("2026-11-30T18:00:00Z"));
    expect(t.calls.at(-1)!.args).toEqual(["copyto", "SUGOR2:sugo-backups/daily/f.sql.gz.gpg", "SUGOR2:sugo-backups/monthly/f.sql.gz.gpg"]);
  });

  it("fails on a size mismatch and still removes the temp file", async () => {
    const t = harness({ remoteSize: 999 });
    await expect(t.svc.encryptAndUpload("/b/f.sql.gz", "f.sql.gz", NOW)).rejects.toThrow(/R2 has 999 bytes/);
    expect(t.removed).toEqual(["/b/f.sql.gz.gpg"]);
  });

  it("refuses a key file other users can read", async () => {
    const t = harness({ keyMode: 0o100644 });
    await expect(t.svc.encryptAndUpload("/b/f.sql.gz", "f.sql.gz", NOW)).rejects.toThrow(/chmod 600/);
    expect(t.calls).toEqual([]);
  });
});

describe("uploadRecordedBackup", () => {
  const row = (extra = {}) => ({ id: 1, fileName: "db_backup_x.sql.gz", filePath: "/b/db_backup_x.sql.gz", createdAt: NOW, offsiteStatus: null, ...extra });

  it("records SKIPPED when R2 is not configured, without alerting", async () => {
    h.backups.set(1, row());
    const t = harness({ env: {} });
    await t.svc.uploadRecordedBackup(1);
    expect(h.backups.get(1)).toMatchObject({ offsiteStatus: "SKIPPED" });
    expect(t.alerts).toEqual([]);
  });

  it("records UPLOADED, prunes old copies and recovers a backup incident", async () => {
    h.backups.set(1, row());
    const t = harness();
    await t.svc.uploadRecordedBackup(1);
    expect(h.backups.get(1)).toMatchObject({ offsiteStatus: "UPLOADED", offsitePath: "daily/db_backup_x.sql.gz.gpg", offsiteError: null });
    expect(t.calls.filter((c) => c.args[0] === "delete").map((c) => c.args.slice(1))).toEqual([
      ["SUGOR2:sugo-backups/daily", "--min-age", "31d"],
      ["SUGOR2:sugo-backups/monthly", "--min-age", "366d"],
    ]);
    expect(h.incidentCalls).toEqual([["recover", expect.objectContaining({ sourceKey: "BACKUP" })]]);
  });

  it("records FAILED with the reason and alerts", async () => {
    h.backups.set(1, row());
    const t = harness({ failOn: "rclone copyto" });
    await t.svc.uploadRecordedBackup(1);
    expect(h.backups.get(1)).toMatchObject({ offsiteStatus: "FAILED", offsiteError: expect.stringContaining("exploded") });
    expect(t.alerts[0]).toMatchObject({ alertType: "BACKUP_FAILURE", title: "Off-site backup upload failed" });
  });
});

describe("checkFreshness", () => {
  const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3600 * 1000);

  it("is quiet while the last verified copy is recent", async () => {
    h.backups.set(1, { id: 1, createdAt: hoursAgo(10), offsiteStatus: "UPLOADED", offsiteAt: hoursAgo(10) });
    const t = harness();
    await t.svc.checkFreshness();
    expect(t.alerts).toEqual([]);
  });

  it("alerts once and opens an incident when the newest copy is too old", async () => {
    h.backups.set(1, { id: 1, createdAt: hoursAgo(50), offsiteStatus: "UPLOADED", offsiteAt: hoursAgo(50) });
    h.backups.set(2, { id: 2, createdAt: hoursAgo(26), offsiteStatus: "FAILED", offsiteAt: null });
    const t = harness();
    await t.svc.checkFreshness();
    expect(t.alerts.map((a) => a.title)).toEqual([`No off-site backup in ${FRESHNESS_HOURS} hours`]);
    expect(h.incidentCalls[0]).toEqual(["open", expect.objectContaining({ sourceKey: "BACKUP", alertId: 9 })]);

    h.openIncident = { id: 1 };
    await t.svc.checkFreshness();
    expect(t.alerts).toHaveLength(1);
  });

  it("stays quiet right after setup, before a night has had a chance to run", async () => {
    h.backups.set(1, { id: 1, createdAt: hoursAgo(3), offsiteStatus: "FAILED", offsiteAt: null });
    const t = harness();
    await t.svc.checkFreshness();
    expect(t.alerts).toEqual([]);
  });
});

// The same gpg arguments the server uses, run for real when gpg is installed.
const hasGpg = (() => {
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Git for Windows' gpg cannot start its agent from a C:\ home path; Linux paths pass through. */
function gpgHome(dir: string): string {
  if (process.platform !== "win32") return dir;
  return "/" + dir[0].toLowerCase() + dir.slice(2).split(path.sep).join("/");
}

describe.skipIf(!hasGpg)("gpg round trip with the production arguments", () => {
  it("decrypts to the same bytes with the key file, and not without it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "offsite-gpg-"));
    try {
      const plain = path.join(dir, "db.sql.gz");
      const enc = `${plain}.gpg`;
      const out = path.join(dir, "out.sql.gz");
      const key = path.join(dir, "key");
      const wrong = path.join(dir, "wrong");
      writeFileSync(plain, Buffer.from("-- dump\nINSERT INTO errands VALUES (1);\n".repeat(200)));
      writeFileSync(key, "k".repeat(64));
      writeFileSync(wrong, "w".repeat(64));
      const home = ["--homedir", gpgHome(dir)];

      await runCommand("gpg", [...home, "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", key,
        "--symmetric", "--cipher-algo", "AES256", "--compress-algo", "none", "--output", enc, plain]);
      expect(readFileSync(enc).includes(Buffer.from("INSERT INTO errands"))).toBe(false);

      await runCommand("gpg", [...home, "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", key, "--decrypt", "--output", out, enc]);
      expect(readFileSync(out).equals(readFileSync(plain))).toBe(true);

      await expect(
        runCommand("gpg", [...home, "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", wrong, "--decrypt", "--output", `${out}.2`, enc])
      ).rejects.toThrow();
      expect(existsSync(`${out}.2`)).toBe(false);
    } finally {
      await runCommand("gpgconf", ["--homedir", gpgHome(dir), "--kill", "gpg-agent"]).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
