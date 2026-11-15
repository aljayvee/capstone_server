import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createLogRetention, POLICIES, MIN_DAYS, effectiveDays } from "../src/services/logRetentionService.js";
import { ServiceError } from "../src/services/ServiceError.js";

// An in-memory stand-in for the few Prisma calls the service makes.
type Row = Record<string, any>;
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date || typeof cond !== "object") return v === cond;
    if ("lt" in cond && !(v < cond.lt)) return false;
    if ("gte" in cond && !(v >= cond.gte)) return false;
    if ("in" in cond && !cond.in.includes(v)) return false;
    if ("notIn" in cond && cond.notIn.includes(v)) return false;
    return true;
  });
}
function table(rows: Row[]) {
  return {
    rows,
    async count({ where }: { where?: Row } = {}) { return rows.filter((r) => matches(r, where)).length; },
    async findMany({ where, take, orderBy, select }: any = {}) {
      let out = rows.filter((r) => matches(r, where));
      if (orderBy) { const [[f, dir]] = Object.entries(orderBy) as [string, string][]; out = [...out].sort((a, b) => (a[f] < b[f] ? -1 : 1) * (dir === "desc" ? -1 : 1)); }
      if (take) out = out.slice(0, take);
      return select ? out.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : out;
    },
    async deleteMany({ where }: { where: Row }) {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
  };
}

const NOW = new Date("2026-11-15T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000);
let id = 1;
const make = (n: number, f: (i: number) => Row) => Array.from({ length: n }, (_, i) => ({ id: id++, ...f(i) }));

function setup(opts: { backup?: "uploaded" | "local-only" | "old" | "none" } = {}) {
  const alerts: Row[] = [];
  const db: any = {
    riderStatusLog: table([...make(7, () => ({ recordedAt: daysAgo(200) })), ...make(3, () => ({ recordedAt: daysAgo(10) }))]),
    notification: table([
      ...make(2, () => ({ createdAt: daysAgo(100), isRead: true })),
      ...make(1, () => ({ createdAt: daysAgo(100), isRead: false })),
      ...make(1, () => ({ createdAt: daysAgo(200), isRead: false })),
    ]),
    accountLoginLog: table(make(2, (i) => ({ createdAt: daysAgo(i ? 400 : 5) }))),
    passwordResetAttempt: table([]),
    blockedIp: table([
      { id: id++, updatedAt: daysAgo(300), status: "ACTIVE" },
      { id: id++, updatedAt: daysAgo(300), status: "EXPIRED" },
      { id: id++, updatedAt: daysAgo(30), status: "EXPIRED" },
    ]),
    sysAdminAlert: Object.assign(
      table([
        { id: id++, createdAt: daysAgo(400), incidentId: null, alertType: "CRITICAL_INTRUSION" },
        { id: id++, createdAt: daysAgo(400), incidentId: 3, alertType: "DB_DOWN" },
        { id: id++, createdAt: daysAgo(400), incidentId: null, alertType: "AUDIT_EXPORT" },
      ]),
      { create: async ({ data }: any) => { alerts.push(data); return data; } },
    ),
    databaseBackup: {
      async findFirst({ where }: any) {
        const b = { none: null, "local-only": { id: 1, createdAt: daysAgo(0.2), status: "COMPLETED", offsiteStatus: "FAILED" }, old: { id: 2, createdAt: daysAgo(2), status: "COMPLETED", offsiteStatus: "UPLOADED" }, uploaded: { id: 3, createdAt: daysAgo(0.1), status: "COMPLETED", offsiteStatus: "UPLOADED" } }[opts.backup ?? "uploaded"];
        return b && matches(b, where) ? { id: b.id } : null;
      },
    },
    async $queryRawUnsafe(sql: string) { return sql.includes("COUNT(*)") ? [{ n: 0 }] : []; },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-"));
  const svc = createLogRetention({ db, configFile: path.join(dir, "cfg.json"), stateFile: path.join(dir, "state.json"), now: () => NOW, batchSize: 2, maxPerPolicy: 1000 });
  return { db, svc, alerts, dir };
}

beforeEach(() => { id = 1; });

describe("log cleanup", () => {
  it("removes only rows past each policy's cutoff, in batches", async () => {
    const { db, svc } = setup();
    const r = await svc.run("MANUAL");
    expect(r.ran).toBe(true);
    expect(r.removed).toMatchObject({ rider_status_samples: 7, notifications_read: 2, notifications_unread: 1, signin_logs: 1, password_resets: 0, ip_bans_inactive: 1, it_alerts: 1 });
    expect(db.riderStatusLog.rows).toHaveLength(3);
    expect(db.notification.rows.map((n: Row) => n.isRead)).toEqual([false]); // the 100-day unread one stays
  });

  it("never touches active bans, incident-linked alerts or export records", async () => {
    const { db, svc } = setup();
    await svc.run("MANUAL");
    expect(db.blockedIp.rows.map((b: Row) => b.status).sort()).toEqual(["ACTIVE", "EXPIRED"]);
    expect(db.sysAdminAlert.rows.map((a: Row) => a.alertType).sort()).toEqual(["AUDIT_EXPORT", "DB_DOWN"]);
  });

  it.each(["none", "local-only", "old"] as const)("removes nothing without a fresh off-site backup (%s)", async (backup) => {
    const { db, svc, alerts } = setup({ backup });
    const r = await svc.run("SCHEDULED");
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toMatch(/off-site/);
    expect(db.riderStatusLog.rows).toHaveLength(10);
    expect(alerts.at(-1)).toMatchObject({ alertType: "LOG_RETENTION_RUN", title: expect.stringContaining("skipped") });
  });

  it("stops at the per-run ceiling and says so", async () => {
    const { db } = setup();
    const svc = createLogRetention({ db, configFile: path.join(os.tmpdir(), `nope-${Date.now()}.json`), stateFile: path.join(os.tmpdir(), `st-${Date.now()}.json`), now: () => NOW, batchSize: 2, maxPerPolicy: 4 });
    const r = await svc.run("MANUAL");
    expect(r.removed.rider_status_samples).toBe(4);
    expect(r.capped).toContain("rider_status_samples");
  });

  it("refuses a second run while one is in progress", async () => {
    const { svc } = setup();
    const first = svc.run("MANUAL");
    await expect(svc.run("MANUAL")).rejects.toBeInstanceOf(ServiceError);
    await first;
  });
});

describe("retention settings", () => {
  it("uses the agreed defaults until changed", () => {
    expect(effectiveDays({ days: {} })).toEqual({ rider_status_samples: 180, notifications_read: 90, notifications_unread: 180, signin_logs: 365, password_resets: 365, ip_bans_inactive: 180, it_alerts: 365 });
    expect(effectiveDays({ days: { signin_logs: 5 } }).signin_logs).toBe(365); // out of range in the file: ignored
  });

  it("saves a change, records who made it, and applies it to the next run", async () => {
    const { db, svc, alerts } = setup();
    await svc.updateDays({ rider_status_samples: 365 }, "jayvee_admin");
    expect(alerts.at(-1)).toMatchObject({ alertType: "LOG_RETENTION_CHANGED", message: expect.stringContaining("180 -> 365") });
    const r = await svc.run("MANUAL");
    expect(r.removed.rider_status_samples).toBe(0);
    expect(db.riderStatusLog.rows).toHaveLength(10);
  });

  it("refuses values that could wipe or bloat a table", async () => {
    const { svc } = setup();
    await expect(svc.updateDays({ signin_logs: MIN_DAYS - 1 }, "x")).rejects.toThrow(/between 30 and 3650/);
    await expect(svc.updateDays({ signin_logs: 90.5 }, "x")).rejects.toThrow(/whole days/);
    await expect(svc.updateDays({ errands: 30 } as any, "x")).rejects.toThrow(/Unknown log/);
    await expect(svc.updateDays({}, "x")).rejects.toThrow(/Nothing to change/);
  });

  it("covers exactly the seven agreed logs", () => {
    expect(POLICIES.map((p) => p.table)).not.toContain("rider_login_sessions");
    expect(POLICIES.map((p) => p.table)).not.toContain("connectivity_incidents");
    expect(POLICIES).toHaveLength(7);
  });
});

describe("status", () => {
  it("previews what the next cleanup would remove without removing it", async () => {
    const { db, svc } = setup();
    const s = await svc.status();
    expect(s.policies.find((p) => p.key === "rider_status_samples")).toMatchObject({ rows: 10, dueForRemoval: 7, days: 180 });
    expect(db.riderStatusLog.rows).toHaveLength(10);
    expect(s.backupGate.ok).toBe(true);
  });
});
