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

describe("health watch: Firebase", () => {
  type FB = import("../src/lib/firebaseHealth.js").FirebaseCheck;
  type RC = import("../src/lib/firebaseHealth.js").RulesCheck;

  function fbSetup() {
    let fb: FB = { status: "ok", latencyMs: 40 };
    let rules: RC = { status: "same" };
    let clock = Date.parse("2026-11-15T00:00:00Z");
    const sent: AlertPayload[] = [];
    const incidentCalls: [string, Record<string, any>][] = [];
    const watch = createHealthWatch({
      checkDatabase: async () => true,
      readDisk: async () => disk(25),
      sendAlert: async (p) => (sent.push(p), { alertId: 200 + sent.length }),
      incidents: {
        open: async (i) => incidentCalls.push(["open", i]),
        recover: async (i) => incidentCalls.push(["recover", i]),
      },
      checkFirebase: async () => fb,
      checkFirebaseRules: async () => rules,
      now: () => clock,
    });
    return {
      watch,
      sent,
      incidentCalls,
      setFb: (v: FB) => (fb = v),
      setRules: (v: RC) => (rules = v),
      advanceMinutes: (m: number) => (clock += m * 60000),
    };
  }
  const down: FB = { status: "failed", latencyMs: 5000, error: "write: no answer within 5000 ms" };

  it("alerts once after three misses, opens an incident, and recovers it", async () => {
    const t = fbSetup();
    t.setFb(down);
    for (let i = 0; i < 6; i++) {
      await t.watch.tickFirebase();
      t.advanceMinutes(1);
    }
    expect(t.sent.map((a) => [a.alertType, a.severity])).toEqual([["FIREBASE_DOWN", "HIGH"]]);
    expect(t.sent[0].message).toContain("no answer within 5000 ms");
    expect(t.incidentCalls).toEqual([["open", expect.objectContaining({ sourceKey: "FIREBASE", alertId: 201 })]]);

    t.setFb({ status: "ok", latencyMs: 30 });
    await t.watch.tickFirebase();
    expect(t.sent.at(-1)).toMatchObject({ alertType: "SERVICE_RECOVERED", title: "Realtime Database answering again" });
    expect(t.sent.at(-1)!.message).toContain("about 6 min");
    expect(t.incidentCalls.at(-1)).toEqual(["recover", expect.objectContaining({ sourceKey: "FIREBASE", alertId: 202 })]);
  });

  it("ignores a short blip and a server with no Firebase configured", async () => {
    const t = fbSetup();
    t.setFb(down);
    await t.watch.tickFirebase();
    await t.watch.tickFirebase();
    t.setFb({ status: "ok", latencyMs: 30 });
    await t.watch.tickFirebase();
    t.setFb({ status: "not_configured" });
    for (let i = 0; i < 5; i++) await t.watch.tickFirebase();
    expect(t.sent).toEqual([]);
  });

  it("alerts on rules drift once per distinct change, and when it is undone", async () => {
    const t = fbSetup();
    await t.watch.tickFirebaseRules(); // same at boot: quiet
    t.setRules({ status: "different", changedKeys: ["chats"] });
    await t.watch.tickFirebaseRules();
    await t.watch.tickFirebaseRules(); // unchanged drift: quiet
    t.setRules({ status: "different", changedKeys: ["chats", "riders"] });
    await t.watch.tickFirebaseRules(); // drift grew: alert again
    t.setRules({ status: "failed", error: "network" });
    await t.watch.tickFirebaseRules(); // a failed comparison says nothing
    t.setRules({ status: "same" });
    await t.watch.tickFirebaseRules();

    expect(t.sent.map((a) => [a.alertType, a.severity])).toEqual([
      ["FIREBASE_RULES_CHANGED", "MEDIUM"],
      ["FIREBASE_RULES_CHANGED", "MEDIUM"],
      ["SERVICE_RECOVERED", "LOW"],
    ]);
    expect(t.sent[1].message).toContain("changed: chats, riders");
    // Drift is a warning, not an outage: no incident.
    expect(t.incidentCalls).toEqual([]);
  });

  it("alerts at boot when the rules already differ", async () => {
    const t = fbSetup();
    t.setRules({ status: "different", changedKeys: [".read"] });
    await t.watch.tickFirebaseRules();
    expect(t.sent.map((a) => a.alertType)).toEqual(["FIREBASE_RULES_CHANGED"]);
  });
});
