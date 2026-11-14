import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import {
  createHealthWatch,
  nextDiskLevel,
  readDiskUsage,
  DB_FAILURES_BEFORE_ALERT,
  type DiskUsage,
} from "../src/jobs/healthWatch.js";
import type { AlertPayload } from "../src/services/sysAdminAlertService.js";

const GB = 1024 ** 3;
const disk = (usedPct: number): DiskUsage => ({
  usedPct,
  freeBytes: ((100 - usedPct) / 100) * 96 * GB,
  totalBytes: 96 * GB,
});

function setup() {
  let dbOk = true;
  let usage = disk(25);
  let clock = Date.parse("2026-11-15T00:00:00Z");
  const sent: AlertPayload[] = [];
  const incidentCalls: [string, Record<string, any>][] = [];
  const watch = createHealthWatch({
    checkDatabase: async () => dbOk,
    readDisk: async () => usage,
    sendAlert: async (p) => {
      sent.push(p);
      return { alertId: 100 + sent.length };
    },
    incidents: {
      open: async (input) => incidentCalls.push(["open", input]),
      recover: async (input) => incidentCalls.push(["recover", input]),
    },
    now: () => clock,
  });
  return {
    watch,
    sent,
    incidentCalls,
    setDb: (ok: boolean) => (dbOk = ok),
    setDisk: (pct: number) => (usage = disk(pct)),
    advanceMinutes: (m: number) => (clock += m * 60000),
  };
}

describe("health watch: database", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("says nothing while the database answers", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) await t.watch.tickDatabase();
    expect(t.sent).toEqual([]);
  });

  it("ignores a short blip below the threshold", async () => {
    const t = setup();
    t.setDb(false);
    for (let i = 0; i < DB_FAILURES_BEFORE_ALERT - 1; i++) await t.watch.tickDatabase();
    t.setDb(true);
    await t.watch.tickDatabase();
    expect(t.sent).toEqual([]);
  });

  it("alerts once per outage, then once on recovery with the duration", async () => {
    const t = setup();
    t.setDb(false);
    for (let i = 0; i < 20; i++) {
      await t.watch.tickDatabase();
      t.advanceMinutes(1);
    }
    expect(t.sent.map((a) => a.alertType)).toEqual(["DB_DISCONNECT"]);
    expect(t.sent[0]).toMatchObject({ severity: "CRITICAL", bypassRepeatLimit: true });

    t.setDb(true);
    await t.watch.tickDatabase();
    expect(t.sent.map((a) => a.alertType)).toEqual(["DB_DISCONNECT", "SERVICE_RECOVERED"]);
    expect(t.sent[1].message).toContain("about 20 min");
    expect(t.sent[1].message).toContain("20 failed checks");
  });

  it("opens the outage incident at the alert and closes it at recovery, timed from the first miss", async () => {
    const t = setup();
    const firstMiss = Date.parse("2026-11-15T00:00:00Z");
    t.setDb(false);
    for (let i = 0; i < 5; i++) {
      await t.watch.tickDatabase();
      t.advanceMinutes(1);
    }
    t.setDb(true);
    await t.watch.tickDatabase();

    expect(t.incidentCalls.map(([kind]) => kind)).toEqual(["open", "recover"]);
    const [, opened] = t.incidentCalls[0];
    expect(opened).toMatchObject({ sourceKey: "DB_DOWN", severity: "CRITICAL", alertId: 101 });
    expect(opened.startedAt.getTime()).toBe(firstMiss);
    expect(opened.detectedAt.getTime()).toBe(firstMiss + 2 * 60000);

    const [, recovered] = t.incidentCalls[1];
    expect(recovered).toMatchObject({ sourceKey: "DB_DOWN", alertId: 102 });
    expect(recovered.recoveredAt.getTime()).toBe(firstMiss + 5 * 60000);
    // The open above usually fails (the DB is down), so recovery can create it.
    expect(recovered.createIfMissing.startedAt.getTime()).toBe(firstMiss);
  });

  it("records no incident for a blip that never alerted", async () => {
    const t = setup();
    t.setDb(false);
    await t.watch.tickDatabase();
    t.setDb(true);
    await t.watch.tickDatabase();
    expect(t.incidentCalls).toEqual([]);
  });

  it("treats a check that throws as a failure", async () => {
    const sent: AlertPayload[] = [];
    const watch = createHealthWatch({
      checkDatabase: async () => {
        throw new Error("boom");
      },
      readDisk: async () => disk(25),
      sendAlert: async (p) => { sent.push(p); return { alertId: null }; },
    });
    for (let i = 0; i < DB_FAILURES_BEFORE_ALERT; i++) await watch.tickDatabase();
    expect(sent.map((a) => a.alertType)).toEqual(["DB_DISCONNECT"]);
  });

  it("keeps watching when sending the alert fails", async () => {
    const watch = createHealthWatch({
      checkDatabase: async () => false,
      readDisk: async () => disk(25),
      sendAlert: async () => {
        throw new Error("telegram down");
      },
    });
    for (let i = 0; i < DB_FAILURES_BEFORE_ALERT + 2; i++) {
      await expect(watch.tickDatabase()).resolves.toBeUndefined();
    }
  });
});

describe("health watch: disk", () => {
  it("levels with hysteresis", () => {
    expect(nextDiskLevel(25, "ok")).toBe("ok");
    expect(nextDiskLevel(85, "ok")).toBe("warn");
    expect(nextDiskLevel(95, "warn")).toBe("critical");
    expect(nextDiskLevel(83, "warn")).toBe("warn");
    expect(nextDiskLevel(83, "critical")).toBe("warn");
    expect(nextDiskLevel(79.9, "warn")).toBe("ok");
    expect(nextDiskLevel(83, "ok")).toBe("ok");
  });

  it("alerts on each change of level, not on every check", async () => {
    const t = setup();
    await t.watch.tickDisk();
    t.setDisk(86);
    await t.watch.tickDisk();
    await t.watch.tickDisk();
    t.setDisk(84); // hovering under 85: still a warning, no new message
    await t.watch.tickDisk();
    t.setDisk(96);
    await t.watch.tickDisk();
    t.setDisk(90);
    await t.watch.tickDisk();
    t.setDisk(70);
    await t.watch.tickDisk();

    expect(t.sent.map((a) => [a.alertType, a.severity, a.title])).toEqual([
      ["DISK_WARNING", "HIGH", "Disk filling up"],
      ["DISK_WARNING", "CRITICAL", "Disk almost full"],
      ["DISK_WARNING", "MEDIUM", "Disk no longer critical, still high"],
      ["SERVICE_RECOVERED", "LOW", "Disk space back to normal"],
    ]);
    // Each warning joins (or opens) the one disk incident; the all-clear recovers it.
    expect(t.incidentCalls.map(([kind, input]) => [kind, input.sourceKey, input.severity ?? null])).toEqual([
      ["open", "DISK", "HIGH"],
      ["open", "DISK", "CRITICAL"],
      ["open", "DISK", "MEDIUM"],
      ["recover", "DISK", null],
    ]);
  });

  it("skips a disk read that fails without alerting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: AlertPayload[] = [];
    const watch = createHealthWatch({
      checkDatabase: async () => true,
      readDisk: async () => {
        throw new Error("EACCES");
      },
      sendAlert: async (p) => { sent.push(p); return { alertId: null }; },
    });
    await watch.tickDisk();
    expect(sent).toEqual([]);
  });

  it("reads this machine's disk", async () => {
    const u = await readDiskUsage();
    expect(u.totalBytes).toBeGreaterThan(0);
    expect(u.usedPct).toBeGreaterThanOrEqual(0);
    expect(u.usedPct).toBeLessThanOrEqual(100);
  });
});
