import { describe, it, expect, vi, beforeEach } from "vitest";

// A tiny in-memory stand-in for the two tables the service touches.
const db = vi.hoisted(() => {
  type Row = Record<string, any>;
  const state = { incidents: [] as Row[], alertLinks: new Map<number, number>(), nextId: 1, failNext: false };
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" && "in" in v ? (v.in as unknown[]).includes(row[k]) : row[k] === v
    );
  const guard = () => {
    if (state.failNext) {
      state.failNext = false;
      throw new Error("Can't reach database server");
    }
  };
  const prisma = {
    sysAdminIncident: {
      findUnique: async ({ where }: Row) => state.incidents.find((r) => r.id === where.id) ?? null,
      findFirst: async ({ where }: Row) => {
        guard();
        return [...state.incidents].reverse().find((r) => matches(r, where)) ?? null;
      },
      create: async ({ data }: Row) => {
        guard();
        const row = {
          id: state.nextId++,
          status: "OPEN",
          severity: "HIGH",
          sourceKey: null,
          detectedAt: new Date(),
          recoveredAt: null,
          resolvedAt: null,
          resolvedBy: null,
          impact: null,
          cause: null,
          fix: null,
          prevention: null,
          ...data,
        };
        state.incidents.push(row);
        return row;
      },
      update: async ({ where, data }: Row) => {
        const row = state.incidents.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    sysAdminAlert: {
      update: async ({ where, data }: Row) => {
        state.alertLinks.set(where.id, data.incidentId);
        return {};
      },
    },
  };
  return { state, prisma };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma: db.prisma }));

import { sysAdminIncidentService as svc } from "../src/services/sysAdminIncidentService.js";
import { createIncidentSchema, updateIncidentSchema } from "../src/validators/sysAdminIncidentValidators.js";

const T0 = new Date("2026-11-01T01:00:00Z");
const minutes = (m: number) => new Date(T0.getTime() + m * 60000);

beforeEach(() => {
  db.state.incidents = [];
  db.state.alertLinks.clear();
  db.state.nextId = 1;
  db.state.failNext = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolving needs the report", () => {
  it("refuses RESOLVED without cause and fix, and names what is missing", async () => {
    const inc = await svc.create({ title: "Orders failing", severity: "HIGH", startedAt: T0 }, "admin");
    await expect(svc.update(inc.id, { status: "RESOLVED" }, "admin")).rejects.toMatchObject({
      status: 400,
      message: "Write down what caused it and what fixed it before resolving this incident.",
    });
    await expect(svc.update(inc.id, { status: "RESOLVED", cause: "Disk full" }, "admin")).rejects.toMatchObject({
      message: "Write down what fixed it before resolving this incident.",
    });
  });

  it("treats blank text as missing", async () => {
    const inc = await svc.create({ title: "Orders failing", severity: "HIGH", startedAt: T0 }, "admin");
    await expect(svc.update(inc.id, { status: "RESOLVED", cause: "   ", fix: "Cleared old backups" }, "admin")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("resolves with cause and fix, stamping who, when, and a recovery time", async () => {
    const inc = await svc.create({ title: "Orders failing", severity: "HIGH", startedAt: T0 }, "admin");
    const done = await svc.update(inc.id, { status: "RESOLVED", cause: " Disk full ", fix: "Cleared old backups" }, "jay");
    expect(done).toMatchObject({ status: "RESOLVED", resolvedBy: "jay", cause: "Disk full" });
    expect(done.resolvedAt).toBeInstanceOf(Date);
    expect(done.recoveredAt).toBeInstanceOf(Date);
  });

  it("reopening clears the resolution but keeps the report", async () => {
    const inc = await svc.create({ title: "Orders failing", severity: "HIGH", startedAt: T0 }, "admin");
    await svc.update(inc.id, { status: "RESOLVED", cause: "Disk full", fix: "Cleared" }, "jay");
    const reopened = await svc.update(inc.id, { status: "OPEN" }, "jay");
    expect(reopened).toMatchObject({ status: "OPEN", resolvedAt: null, resolvedBy: null, cause: "Disk full" });
  });

  it("rejects a recovery time before the start", async () => {
    const inc = await svc.create({ title: "Orders failing", severity: "HIGH", startedAt: T0 }, "admin");
    await expect(svc.update(inc.id, { recoveredAt: minutes(-5) }, "admin")).rejects.toMatchObject({ status: 400 });
  });

  it("404s an unknown incident", async () => {
    await expect(svc.update(999, { title: "x y z" }, "admin")).rejects.toMatchObject({ status: 404 });
  });
});

describe("automatic incidents", () => {
  it("opens one per key and joins it on repeat, raising severity and linking alerts", async () => {
    const a = await svc.openAutomatic({ sourceKey: "DISK", title: "Disk filling up", severity: "HIGH", startedAt: T0, alertId: 11 });
    const b = await svc.openAutomatic({ sourceKey: "DISK", title: "Disk filling up", severity: "CRITICAL", startedAt: minutes(15), alertId: 12 });
    expect(b).toBe(a);
    expect(db.state.incidents).toHaveLength(1);
    expect(db.state.incidents[0]).toMatchObject({ severity: "CRITICAL", startedAt: T0 });
    expect([...db.state.alertLinks.entries()]).toEqual([[11, a], [12, a]]);
  });

  it("never lowers severity when joining", async () => {
    await svc.openAutomatic({ sourceKey: "DISK", title: "Disk", severity: "CRITICAL", startedAt: T0 });
    await svc.openAutomatic({ sourceKey: "DISK", title: "Disk", severity: "MEDIUM", startedAt: minutes(1) });
    expect(db.state.incidents[0].severity).toBe("CRITICAL");
  });

  it("recovery moves OPEN to MONITORING; a later problem opens a new incident once resolved", async () => {
    const id = await svc.openAutomatic({ sourceKey: "DISK", title: "Disk", severity: "HIGH", startedAt: T0 });
    await svc.recoverAutomatic({ sourceKey: "DISK", recoveredAt: minutes(30), alertId: 21 });
    expect(db.state.incidents[0]).toMatchObject({ status: "MONITORING", recoveredAt: minutes(30) });
    expect(db.state.alertLinks.get(21)).toBe(id);

    await svc.update(id!, { status: "RESOLVED", cause: "Logs", fix: "Rotated" }, "jay");
    const next = await svc.openAutomatic({ sourceKey: "DISK", title: "Disk", severity: "HIGH", startedAt: minutes(90) });
    expect(next).not.toBe(id);
  });

  it("records a database outage at recovery when it could not be recorded during it", async () => {
    const id = await svc.recoverAutomatic({
      sourceKey: "DB_DOWN",
      recoveredAt: minutes(20),
      alertId: 31,
      createIfMissing: { title: "Database not answering", severity: "CRITICAL", startedAt: T0, detectedAt: minutes(3) },
    });
    expect(db.state.incidents[0]).toMatchObject({
      id,
      sourceKey: "DB_DOWN",
      status: "MONITORING",
      startedAt: T0,
      detectedAt: minutes(3),
      recoveredAt: minutes(20),
    });
    expect(db.state.alertLinks.get(31)).toBe(id);
  });

  it("recovery without an incident and without createIfMissing does nothing", async () => {
    expect(await svc.recoverAutomatic({ sourceKey: "DISK", recoveredAt: T0 })).toBeNull();
    expect(db.state.incidents).toHaveLength(0);
  });

  it("a crash incident starts as MONITORING", async () => {
    await svc.openAutomatic({ sourceKey: "BACKEND_CRASH", title: "Backend restarted", severity: "HIGH", startedAt: T0, recoveredAt: T0 });
    expect(db.state.incidents[0]).toMatchObject({ status: "MONITORING", recoveredAt: T0 });
  });

  it("never throws when the database is down", async () => {
    db.state.failNext = true;
    await expect(
      svc.openAutomatic({ sourceKey: "DB_DOWN", title: "Database not answering", severity: "CRITICAL", startedAt: T0 })
    ).resolves.toBeNull();
    db.state.failNext = true;
    await expect(svc.recoverAutomatic({ sourceKey: "DB_DOWN", recoveredAt: T0 })).resolves.toBeNull();
  });
});

describe("validators", () => {
  it("rejects a start time in the future and a short title", () => {
    const future = new Date(Date.now() + 60 * 60000).toISOString();
    expect(createIncidentSchema.safeParse({ title: "Outage", startedAt: future }).success).toBe(false);
    expect(createIncidentSchema.safeParse({ title: "x", startedAt: T0.toISOString() }).success).toBe(false);
  });

  it("accepts a manual incident with default severity", () => {
    const parsed = createIncidentSchema.parse({ title: "Site down", startedAt: T0.toISOString() });
    expect(parsed).toMatchObject({ severity: "HIGH", startedAt: T0 });
  });

  it("rejects unknown fields and an empty patch", () => {
    expect(updateIncidentSchema.safeParse({ resolvedBy: "me" }).success).toBe(false);
    expect(updateIncidentSchema.safeParse({}).success).toBe(false);
    expect(updateIncidentSchema.safeParse({ recoveredAt: null }).success).toBe(true);
  });
});
