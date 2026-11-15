import http from "node:http";
import bcrypt from "bcryptjs";
import express from "express";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JWT_SECRET } from "../src/config/env.js";

// Stateful in-memory Prisma store so full Express HTTP requests exercise
// real route chains, CSRF checks, step-up password checks, PMA service logic,
// permission caching, Mutual Root Protection, and Dual Governance.
const state = vi.hoisted(() => {
  const sysAdmins = [
    {
      id: 1,
      username: "main_sysadmin",
      nickname: "MainRoot",
      email: "main.sysadmin@sugo.local",
      passwordHash: "",
      status: "Active",
      twoFactorEnabled: false,
      accessGroupId: null as number | null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastLoginAt: null as Date | null,
    },
    {
      id: 2,
      username: "sec_sysadmin",
      nickname: "SecOps",
      email: "sec.sysadmin@sugo.local",
      passwordHash: "",
      status: "Active",
      twoFactorEnabled: false,
      accessGroupId: null as number | null,
      createdAt: new Date("2026-01-02T00:00:00Z"),
      lastLoginAt: null as Date | null,
    },
  ];

  const users = [
    {
      id: 10,
      username: "main_owner",
      name: "Main Owner",
      email: "owner@sugo.local",
      role: "OWNER",
      status: "Active",
    },
    {
      id: 11,
      username: "co_owner",
      name: "Co Owner",
      email: "coowner@sugo.local",
      role: "OWNER",
      status: "Active",
    },
  ];

  const groups: Array<{
    id: number;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  const groupPermissions: Array<{ id: number; groupId: number; permissionKey: string }> = [];
  const overrides: Array<{ id: number; sysAdminId: number; permissionKey: string; effect: "GRANT" | "DENY" }> = [];
  const pmaAudits: Array<Record<string, unknown>> = [];
  const modLogs: Array<Record<string, unknown>> = [];
  let nextGroupId = 1;
  let nextGpId = 1;
  let nextOvId = 1;
  let nextAuditId = 1;

  function hydrateAdmin(admin: (typeof sysAdmins)[number]) {
    const group = admin.accessGroupId ? groups.find((g) => g.id === admin.accessGroupId) ?? null : null;
    const perms = group
      ? groupPermissions.filter((gp) => gp.groupId === group.id).map((gp) => ({ permissionKey: gp.permissionKey }))
      : [];
    const adminOverrides = overrides
      .filter((o) => o.sysAdminId === admin.id)
      .map((o) => ({ permissionKey: o.permissionKey, effect: o.effect }));
    return {
      ...admin,
      accessGroup: group ? { id: group.id, name: group.name, permissions: perms } : null,
      permissionOverrides: adminOverrides,
    };
  }

  function hydrateGroup(group: (typeof groups)[number]) {
    const perms = groupPermissions
      .filter((gp) => gp.groupId === group.id)
      .map((gp) => ({ permissionKey: gp.permissionKey }));
    const assigned = sysAdmins
      .filter((a) => a.accessGroupId === group.id)
      .map((a) => ({ id: a.id, username: a.username, nickname: a.nickname, status: a.status }));
    return {
      ...group,
      permissions: perms,
      sysAdmins: assigned,
      _count: { sysAdmins: assigned.length },
    };
  }

  const reset = (hash: string) => {
    sysAdmins[0].passwordHash = hash;
    sysAdmins[0].status = "Active";
    sysAdmins[0].accessGroupId = null;
    sysAdmins[1].passwordHash = hash;
    sysAdmins[1].status = "Active";
    sysAdmins[1].accessGroupId = null;
    users[0].status = "Active";
    users[1].status = "Active";
    groups.length = 0;
    groupPermissions.length = 0;
    overrides.length = 0;
    pmaAudits.length = 0;
    modLogs.length = 0;
    nextGroupId = 1;
    nextGpId = 1;
    nextOvId = 1;
    nextAuditId = 1;
  };

  const db = {
    sysAdmin: {
      findFirst: vi.fn(async (args?: { orderBy?: { id: string } }) => {
        const sorted = [...sysAdmins].sort((a, b) => (args?.orderBy?.id === "asc" ? a.id - b.id : b.id - a.id));
        return sorted[0] ?? null;
      }),
      findUnique: vi.fn(async ({ where, include, select }: { where: { id?: number }; include?: unknown; select?: unknown }) => {
        const row = sysAdmins.find((a) => a.id === where.id);
        if (!row) return null;
        return include || select ? hydrateAdmin(row) : { ...row };
      }),
      findMany: vi.fn(async () => sysAdmins.map(hydrateAdmin)),
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<(typeof sysAdmins)[number]> }) => {
        const row = sysAdmins.find((a) => a.id === where.id);
        if (!row) throw new Error("SysAdmin not found");
        Object.assign(row, data);
        return hydrateAdmin(row);
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where?: { role?: string } }) => {
        return users.find((u) => !where?.role || u.role === where.role) ?? null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: number } }) => {
        return users.find((u) => u.id === where.id) ?? null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<(typeof users)[number]> }) => {
        const row = users.find((u) => u.id === where.id);
        if (!row) throw new Error("User not found");
        Object.assign(row, data);
        return { ...row };
      }),
    },
    customer: {
      findUnique: vi.fn(async () => null),
    },
    sysAdminAccessGroup: {
      findMany: vi.fn(async () => groups.map(hydrateGroup)),
      findUnique: vi.fn(async ({ where }: { where: { id?: number; name?: string } }) => {
        const row = groups.find((g) => (where.id !== undefined ? g.id === where.id : g.name === where.name));
        return row ? hydrateGroup(row) : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { name?: string; id?: { not?: number } } }) => {
        const row = groups.find(
          (g) =>
            (where.name === undefined || g.name.toLowerCase() === where.name.toLowerCase()) &&
            (where.id?.not === undefined || g.id !== where.id.not)
        );
        return row ? hydrateGroup(row) : null;
      }),
      create: vi.fn(async ({ data }: { data: { name: string; description?: string | null } }) => {
        const now = new Date();
        const created = { id: nextGroupId++, name: data.name, description: data.description ?? null, createdAt: now, updatedAt: now };
        groups.push(created);
        return hydrateGroup(created);
      }),
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: { name?: string; description?: string | null } }) => {
        const row = groups.find((g) => g.id === where.id);
        if (!row) throw new Error("Group not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return hydrateGroup(row);
      }),
      delete: vi.fn(async ({ where }: { where: { id: number } }) => {
        const idx = groups.findIndex((g) => g.id === where.id);
        if (idx >= 0) groups.splice(idx, 1);
        return {};
      }),
    },
    sysAdminAccessGroupPermission: {
      deleteMany: vi.fn(async ({ where }: { where: { groupId: number } }) => {
        for (let i = groupPermissions.length - 1; i >= 0; i--) {
          if (groupPermissions[i].groupId === where.groupId) groupPermissions.splice(i, 1);
        }
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<{ groupId: number; permissionKey: string }> }) => {
        for (const row of data) {
          groupPermissions.push({ id: nextGpId++, groupId: row.groupId, permissionKey: row.permissionKey });
        }
        return { count: data.length };
      }),
    },
    sysAdminPermissionOverride: {
      deleteMany: vi.fn(async ({ where }: { where: { sysAdminId: number } }) => {
        for (let i = overrides.length - 1; i >= 0; i--) {
          if (overrides[i].sysAdminId === where.sysAdminId) overrides.splice(i, 1);
        }
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<{ sysAdminId: number; permissionKey: string; effect: "GRANT" | "DENY" }> }) => {
        for (const row of data) {
          overrides.push({ id: nextOvId++, ...row });
        }
        return { count: data.length };
      }),
    },
    sysAdminPmaAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextAuditId++, createdAt: new Date(), ...data };
        pmaAudits.unshift(row);
        return row;
      }),
      findMany: vi.fn(async () => pmaAudits),
      count: vi.fn(async () => pmaAudits.length),
    },
    accountModificationLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        modLogs.push(data);
        return data;
      }),
    },
    sysAdminAlert: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    sysAdminTrustedDevice: {
      findMany: vi.fn(async () => []),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };

  return { db, reset, pmaAudits };
});

const socketMocks = vi.hoisted(() => ({
  notifySysAdminPermissionsChanged: vi.fn(),
  notifySessionRevoked: vi.fn(),
  disconnectAccount: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  revokeAllForSubject: vi.fn(async () => 1),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: state.db }));
vi.mock("../src/lib/blocklistCache.js", () => ({ isRevoked: vi.fn(async () => false) }));
vi.mock("../src/lib/socket.js", () => socketMocks);
vi.mock("../src/services/sessionService.js", () => sessionMocks);

// Avoid express-rate-limit timers hanging Vitest while keeping CSRF, security headers, and step-up checks live.
vi.mock("../src/middleware/rateLimiters.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    readLimiter: pass,
    userApiLimiter: pass,
    verificationLimiter: pass,
    authLimiter: pass,
    strictLimiter: pass,
  };
});

vi.mock("../src/middleware/sysAdminSecurity.js", async () => {
  const actual = await vi.importActual<typeof import("../src/middleware/sysAdminSecurity.js")>(
    "../src/middleware/sysAdminSecurity.js"
  );
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    ...actual,
    sysAdminLoginLimiter: pass,
    sysAdminBackupLimiter: pass,
    sysAdminMaintenanceLimiter: pass,
    sysAdminMutationLimiter: pass,
  };
});

import sysAdminRoutes from "../src/routes/sysAdminRoutes.js";
import accessRoutes from "../src/routes/accessRoutes.js";
import { invalidateMainSysAdmin } from "../src/lib/mainSysAdmin.js";
import { invalidateSysAdminPermissions } from "../src/lib/sysAdminPermissionCache.js";
import { invalidateMainOwner } from "../src/lib/mainOwner.js";

function signToken(payload: { id: number; username: string; email: string; role: string }) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
}

describe("SysAdmin PMA HTTP integration (Express routers + real middleware chains)", () => {
  let server: http.Server;
  let baseUrl = "";
  let passwordHash = "";

  const mainSysAdminToken = signToken({
    id: 1,
    username: "main_sysadmin",
    email: "main.sysadmin@sugo.local",
    role: "SYSADMIN",
  });
  const secondarySysAdminToken = signToken({
    id: 2,
    username: "sec_sysadmin",
    email: "sec.sysadmin@sugo.local",
    role: "SYSADMIN",
  });
  const mainOwnerToken = signToken({
    id: 10,
    username: "main_owner",
    email: "owner@sugo.local",
    role: "OWNER",
  });
  const coOwnerToken = signToken({
    id: 11,
    username: "co_owner",
    email: "coowner@sugo.local",
    role: "OWNER",
  });

  beforeAll(async () => {
    passwordHash = await bcrypt.hash("RootAdminPass123!", 4);
    const app = express();
    app.use(express.json());
    app.use("/api", sysAdminRoutes);
    app.use("/api", accessRoutes);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind test HTTP server");
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.reset(passwordHash);
    invalidateMainSysAdmin();
    invalidateSysAdminPermissions();
    invalidateMainOwner();
  });

  it("enforces X-SysAdmin-Client CSRF protection on mutating /sysadmin/pma routes", async () => {
    const res = await fetch(`${baseUrl}/sysadmin/pma/groups`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mainSysAdminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Ops Group", permissions: ["telemetry.view"], stepUpPassword: "RootAdminPass123!" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/CSRF/i);
  });

  it("enforces Least-Privilege Read-Only Baseline and Self-Service exemption for new secondary IT Admins", async () => {
    const meRes = await fetch(`${baseUrl}/sysadmin/pma/me`, {
      headers: { Authorization: `Bearer ${secondarySysAdminToken}` },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.isMainSysAdmin).toBe(false);
    expect([...me.permissions].sort()).toEqual([
      "audit.view",
      "incidents.view",
      "logs.view",
      "telemetry.view",
      "traffic.view",
    ]);

    // Baseline monitoring view endpoint is allowed
    const alertsRes = await fetch(`${baseUrl}/sysadmin/devops/alerts/status`, {
      headers: { Authorization: `Bearer ${secondarySysAdminToken}` },
    });
    expect(alertsRes.status).toBe(200);

    // Self-service trusted-devices route remains open to every active SysAdmin
    const devicesRes = await fetch(`${baseUrl}/sysadmin/auth/trusted-devices`, {
      headers: { Authorization: `Bearer ${secondarySysAdminToken}` },
    });
    expect(devicesRes.status).toBe(200);

    // Management, non-baseline views, and PMA admin routes are blocked with 403
    const blockedChecks = [
      fetch(`${baseUrl}/sysadmin/devops/incidents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secondarySysAdminToken}`,
          "X-SysAdmin-Client": "sugo-sysadmin-web",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "x", cause: "x" }),
      }),
      fetch(`${baseUrl}/sysadmin/devops/server-error`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secondarySysAdminToken}`,
          "X-SysAdmin-Client": "sugo-sysadmin-web",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ active: true }),
      }),
      fetch(`${baseUrl}/sysadmin/users`, {
        headers: { Authorization: `Bearer ${secondarySysAdminToken}` },
      }),
      fetch(`${baseUrl}/sysadmin/pma/groups`, {
        headers: { Authorization: `Bearer ${secondarySysAdminToken}` },
      }),
    ];

    const responses = await Promise.all(blockedChecks);
    for (const r of responses) {
      expect(r.status).toBe(403);
    }
  });

  it("requires valid step-up password on Main SysAdmin PMA writes and accepts x-step-up-password header on DELETE", async () => {
    const noPwRes = await fetch(`${baseUrl}/sysadmin/pma/groups`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mainSysAdminToken}`,
        "X-SysAdmin-Client": "sugo-sysadmin-web",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Security Ops", permissions: ["threats.view"] }),
    });
    expect(noPwRes.status).toBe(403);
    const noPwBody = await noPwRes.json();
    expect(noPwBody.stepUpRequired).toBe(true);

    const badPwRes = await fetch(`${baseUrl}/sysadmin/pma/groups`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mainSysAdminToken}`,
        "X-SysAdmin-Client": "sugo-sysadmin-web",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Security Ops", permissions: ["threats.view"], stepUpPassword: "WrongPassword!" }),
    });
    expect(badPwRes.status).toBe(403);

    const createRes = await fetch(`${baseUrl}/sysadmin/pma/groups`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mainSysAdminToken}`,
        "X-SysAdmin-Client": "sugo-sysadmin-web",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Security Ops",
        description: "Threat views",
        permissions: ["threats.view", "threats.manage"],
        stepUpPassword: "RootAdminPass123!",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.group.name).toBe("Security Ops");
    expect(state.pmaAudits[0]).toMatchObject({ actorRole: "SYSADMIN", action: "GROUP_CREATED" });

    // DELETE sends x-step-up-password header cleanly (no body required)
    const delRes = await fetch(`${baseUrl}/sysadmin/pma/groups/${created.group.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${mainSysAdminToken}`,
        "X-SysAdmin-Client": "sugo-sysadmin-web",
        "x-step-up-password": "RootAdminPass123!",
      },
    });
    expect(delRes.status).toBe(200);
  });

  it("enforces Dual Governance on /access/sysadmin/*, Mutual Root Protection, live permission refresh, and immediate session revocation", async () => {
    // Secondary Owner is blocked from Owner-portal SysAdmin PMA
    const coOwnerRes = await fetch(`${baseUrl}/access/sysadmin/accounts`, {
      headers: { Authorization: `Bearer ${coOwnerToken}` },
    });
    expect(coOwnerRes.status).toBe(403);

    // Main Owner cannot restrict or downgrade Main SysAdmin (#1)
    const tamperRootRes = await fetch(`${baseUrl}/access/sysadmin/accounts/1`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${mainOwnerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accessGroupId: null,
        overrides: [{ permissionKey: "staff.manage", effect: "DENY" }],
      }),
    });
    expect(tamperRootRes.status).toBe(403);

    // Main Owner grants users.view + users.status to secondary SysAdmin (#2)
    const grantRes = await fetch(`${baseUrl}/access/sysadmin/accounts/2`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${mainOwnerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accessGroupId: null,
        overrides: [
          { permissionKey: "users.view", effect: "GRANT" },
          { permissionKey: "users.status", effect: "GRANT" },
        ],
      }),
    });
    expect(grantRes.status).toBe(200);
    expect(socketMocks.notifySysAdminPermissionsChanged).toHaveBeenCalledWith([2]);

    // Live cache invalidated: secondary SysAdmin immediately sees users.view + users.status
    const meAfterGrant = await fetch(`${baseUrl}/sysadmin/pma/me`, {
      headers: { Authorization: `Bearer ${secondarySysAdminToken}` },
    });
    const meJson = await meAfterGrant.json();
    expect(meJson.permissions).toContain("users.view");
    expect(meJson.permissions).toContain("users.status");

    // Mutual Root Protection: secondary SysAdmin with users.status CANNOT suspend Main Owner (#10)
    const suspendOwnerRes = await fetch(`${baseUrl}/sysadmin/users/OWNER/10/status`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${secondarySysAdminToken}`,
        "X-SysAdmin-Client": "sugo-sysadmin-web",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "Suspended", stepUpPassword: "RootAdminPass123!" }),
    });
    expect(suspendOwnerRes.status).toBe(403);

    // Role Namespace Guard: SysAdmin role cannot be targeted via /sysadmin/users/:role/:id/*
    const invalidStatusRoleRes = await fetch(`${baseUrl}/sysadmin/users/SYSADMIN/2/status`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${secondarySysAdminToken}`,
        "X-SysAdmin-Client": "sugo-sysadmin-web",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "Suspended", stepUpPassword: "RootAdminPass123!" }),
    });
    expect(invalidStatusRoleRes.status).toBe(400);

    const invalidSessionsRoleRes = await fetch(`${baseUrl}/sysadmin/users/SYSADMIN/2/sessions`, {
      headers: { Authorization: `Bearer ${secondarySysAdminToken}` },
    });
    expect(invalidSessionsRoleRes.status).toBe(400);

    // Main Owner suspends secondary SysAdmin (#2): revokes sessions, emits session:revoked, and disconnects sockets
    const suspendSecRes = await fetch(`${baseUrl}/access/sysadmin/accounts/2/status`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${mainOwnerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "Suspended", reason: "Shift ended" }),
    });
    expect(suspendSecRes.status).toBe(200);
    expect(sessionMocks.revokeAllForSubject).toHaveBeenCalledWith("SYSADMIN", 2, "SYSADMIN_STATUS_UPDATED");
    expect(socketMocks.notifySessionRevoked).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ reason: "SYSADMIN_STATUS_UPDATED" }),
      "SYSADMIN"
    );
    expect(socketMocks.disconnectAccount).toHaveBeenCalledWith(2, "SYSADMIN");

    // Suspended SysAdmin is immediately blocked fail-closed by requireSysAdminPermission
    const postSuspendAlertsRes = await fetch(`${baseUrl}/sysadmin/devops/alerts/status`, {
      headers: { Authorization: `Bearer ${secondarySysAdminToken}` },
    });
    expect(postSuspendAlertsRes.status).toBe(403);
  });

  it("rejects non-session tokens carrying purpose on /sysadmin/traffic/report", async () => {
    const challengeToken = jwt.sign(
      { id: 1, username: "main_sysadmin", email: "main.sysadmin@sugo.local", role: "SYSADMIN", purpose: "2fa_pending" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "10m" }
    );
    const res = await fetch(`${baseUrl}/sysadmin/traffic/report?token=${encodeURIComponent(challengeToken)}`);
    expect(res.status).toBe(401);
  });
});
