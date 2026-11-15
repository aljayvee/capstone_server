import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prisma,
  notifySysAdminPermissionsChanged,
  notifyPermissionsChanged,
  notifySessionRevoked,
  disconnectAccount,
  revokeAllForSubject,
  revokeAllSubjectSessions,
  logRefusal,
} = vi.hoisted(() => {
  const prisma: any = {
    sysAdmin: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    sysAdminAccessGroup: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    sysAdminAccessGroupPermission: {
      deleteMany: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({})),
    },
    sysAdminPermissionOverride: {
      deleteMany: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({})),
    },
    sysAdminPmaAuditLog: {
      create: vi.fn(async () => ({ id: 1 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    customerAccount: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    accountModificationLog: {
      create: vi.fn(async () => ({ id: 1 })),
    },
  };
  prisma.$transaction = vi.fn(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg)
  );
  return {
    prisma,
    notifySysAdminPermissionsChanged: vi.fn(),
    notifyPermissionsChanged: vi.fn(),
    notifySessionRevoked: vi.fn(),
    disconnectAccount: vi.fn(),
    revokeAllForSubject: vi.fn(async () => {}),
    revokeAllSubjectSessions: vi.fn(async () => {}),
    logRefusal: vi.fn(),
  };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma }));
vi.mock("../src/lib/authzLog.js", () => ({ logRefusal }));
vi.mock("../src/lib/blocklistCache.js", () => ({
  isRevoked: vi.fn(async () => false),
  markRevoked: vi.fn(),
}));
vi.mock("../src/lib/socket.js", async (orig) => {
  const actual = await orig<typeof import("../src/lib/socket.js")>();
  return {
    ...actual,
    notifySysAdminPermissionsChanged,
    notifyPermissionsChanged,
    notifySessionRevoked,
    disconnectAccount,
  };
});
vi.mock("../src/services/sessionService.js", () => ({
  revokeAllForSubject,
  revokeAllSubjectSessions,
  revokeSession: vi.fn(async () => {}),
}));
vi.mock("../src/config/env.js", async (orig) => ({
  ...(await orig<typeof import("../src/config/env.js")>()),
  JWT_SECRET: "test-secret",
}));

import {
  ALL_SYSADMIN_PERMISSION_KEYS,
  READ_ONLY_BASELINE_KEYS,
  SYSADMIN_PERMISSIONS,
  SYSADMIN_PERMISSION_AREAS,
  missingSysAdminRequires,
} from "../src/lib/sysAdminPermissions.js";
import { getMainSysAdminId, invalidateMainSysAdmin } from "../src/lib/mainSysAdmin.js";
import { invalidateMainOwner } from "../src/lib/mainOwner.js";
import {
  getEffectiveSysAdminPermissions,
  invalidateSysAdminPermissions,
  resolveSysAdminPermissions,
} from "../src/lib/sysAdminPermissionCache.js";
import { getEffectivePermissions, invalidatePermissions } from "../src/lib/permissionCache.js";
import { identityRooms } from "../src/lib/socket.js";
import { requireMainSysAdmin, requireSysAdminPermission } from "../src/middleware/auth.js";
import {
  createSysAdminGroup,
  deleteSysAdminGroup,
  updateSysAdminAccountAccess,
  updateSysAdminAccountStatus,
} from "../src/services/sysAdminPmaService.js";
import { updateAccountStatus } from "../src/services/sysAdminUserService.js";
import sysAdminRoutes from "../src/routes/sysAdminRoutes.js";
import accessRoutes from "../src/routes/accessRoutes.js";

function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateMainSysAdmin();
  invalidateMainOwner();
  invalidateSysAdminPermissions();
  invalidatePermissions();
  prisma.sysAdmin.findFirst.mockResolvedValue({ id: 1 });
  prisma.user.findFirst.mockResolvedValue({ id: 1 });
});

describe("SysAdmin PMA catalog and dependency rules", () => {
  it("defines 19 capabilities across 5 areas and a 5-key Read-Only Monitoring baseline", () => {
    expect(SYSADMIN_PERMISSIONS).toHaveLength(19);
    expect(ALL_SYSADMIN_PERMISSION_KEYS).toHaveLength(19);
    expect(SYSADMIN_PERMISSION_AREAS).toEqual([
      "Monitoring & Logs",
      "Users & Sessions",
      "Security & Threats",
      "DevOps & Infrastructure",
      "App Releases & IT Staff",
    ]);
    expect(READ_ONLY_BASELINE_KEYS).toEqual([
      "telemetry.view",
      "traffic.view",
      "logs.view",
      "audit.view",
      "incidents.view",
    ]);
  });

  it("flags action capabilities missing their required view prerequisites", () => {
    const missing = missingSysAdminRequires([
      "threats.manage",
      "users.status",
      "devops.backups.manage",
      "telemetry.view",
    ]);
    expect(missing).toEqual([
      { key: "threats.manage", requires: "threats.view" },
      { key: "users.status", requires: "users.view" },
      { key: "devops.backups.manage", requires: "devops.backups.view" },
    ]);
  });
});

describe("SysAdmin least-privilege resolver and ID/namespace isolation", () => {
  it("gives newly provisioned secondary IT Admins (no group) only the 5 Read-Only Monitoring keys", () => {
    expect(resolveSysAdminPermissions(null, [], false)).toEqual([...READ_ONLY_BASELINE_KEYS]);
  });

  it("applies GRANT and DENY overrides on top of group permissions", () => {
    const keys = resolveSysAdminPermissions(
      ["telemetry.view", "threats.view", "threats.manage"],
      [
        { permissionKey: "threats.manage", effect: "DENY" },
        { permissionKey: "users.view", effect: "GRANT" },
      ],
      false
    );
    expect(keys).toEqual(["telemetry.view", "users.view", "threats.view"]);
  });

  it("always keeps all 19 keys for Main SysAdmin regardless of group or DENY overrides", () => {
    const keys = resolveSysAdminPermissions(
      ["telemetry.view"],
      [{ permissionKey: "staff.manage", effect: "DENY" }],
      true
    );
    expect(keys).toEqual([...ALL_SYSADMIN_PERMISSION_KEYS]);
  });

  it("derives Main SysAdmin strictly from lowest tbl_sys_admin.id", async () => {
    prisma.sysAdmin.findFirst.mockResolvedValue({ id: 3 });
    await expect(getMainSysAdminId()).resolves.toBe(3);
    expect(prisma.sysAdmin.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: "asc" } })
    );
  });

  it("isolates Socket.IO rooms and permission caches between User #1 and SysAdmin #1", async () => {
    expect(identityRooms(1, "SYSADMIN")).toEqual(["sysadmin:1", "role:SYSADMIN"]);
    expect(identityRooms(1, "SYSADMIN")).not.toContain("user:1");
    expect(identityRooms(1, "OWNER")).toEqual(["user:1", "role:OWNER"]);

    prisma.sysAdmin.findUnique.mockResolvedValue({
      id: 1,
      status: "Active",
      accessGroupId: null,
      accessGroup: null,
      permissionOverrides: [],
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      role: "DISPATCHER",
      accessGroup: { id: 9, name: "Dispatcher", scope: "DISPATCHER", permissions: [{ permissionKey: "queue.view" }] },
      permissionOverrides: [],
    });
    prisma.user.findFirst.mockResolvedValue({ id: 99 });

    const sysAdminEff = await getEffectiveSysAdminPermissions(1);
    const userEff = await getEffectivePermissions(1, "DISPATCHER");

    expect(sysAdminEff?.isMainSysAdmin).toBe(true);
    expect(sysAdminEff?.permissions).toHaveLength(19);
    expect(userEff?.permissions).toEqual(["queue.view"]);
  });
});

describe("requireSysAdminPermission and requireMainSysAdmin fail-closed middleware", () => {
  it("refuses unauthenticated callers, non-SYSADMIN roles, and secondary IT Admins without the key", async () => {
    const mw = requireSysAdminPermission("threats.manage");

    // Non-SYSADMIN caller
    const nextWrongRole = vi.fn();
    const resWrongRole = mockRes();
    await mw({ user: { id: 1, role: "OWNER" }, originalUrl: "/api/sysadmin/threats/blocklist", method: "POST" } as any, resWrongRole, nextWrongRole);
    expect(resWrongRole.status).toHaveBeenCalledWith(403);
    expect(nextWrongRole).not.toHaveBeenCalled();

    // Secondary IT Admin #2 defaulting to Read-Only Monitoring
    prisma.sysAdmin.findUnique.mockResolvedValue({
      id: 2,
      status: "Active",
      accessGroupId: null,
      accessGroup: null,
      permissionOverrides: [],
    });
    const nextDenied = vi.fn();
    const resDenied = mockRes();
    await mw({ user: { id: 2, role: "SYSADMIN" }, originalUrl: "/api/sysadmin/threats/blocklist", method: "POST" } as any, resDenied, nextDenied);
    expect(resDenied.status).toHaveBeenCalledWith(403);
    expect(resDenied.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PERMISSION_DENIED", permission: "threats.manage" })
    );
    expect(logRefusal).toHaveBeenCalled();
    expect(nextDenied).not.toHaveBeenCalled();
  });

  it("allows secondary IT Admin holding the granted permission and blocks them on requireMainSysAdmin", async () => {
    prisma.sysAdmin.findUnique.mockResolvedValue({
      id: 2,
      status: "Active",
      accessGroupId: null,
      accessGroup: null,
      permissionOverrides: [
        { permissionKey: "threats.view", effect: "GRANT" },
        { permissionKey: "threats.manage", effect: "GRANT" },
      ],
    });

    const nextAllowed = vi.fn();
    await requireSysAdminPermission("threats.manage")(
      { user: { id: 2, role: "SYSADMIN" } } as any,
      mockRes(),
      nextAllowed
    );
    expect(nextAllowed).toHaveBeenCalledOnce();

    const resNotRoot = mockRes();
    const nextRoot = vi.fn();
    await requireMainSysAdmin({ user: { id: 2, role: "SYSADMIN" } } as any, resNotRoot, nextRoot);
    expect(resNotRoot.status).toHaveBeenCalledWith(403);
    expect(nextRoot).not.toHaveBeenCalled();
  });
});

describe("Dual governance, Mutual Root Protection, live refresh, and dependency enforcement", () => {
  it("allows Main Owner and Main SysAdmin to create access groups and refuses non-root actors", async () => {
    prisma.sysAdminAccessGroup.create.mockResolvedValue({
      id: 10,
      name: "Threat Operators",
      description: "IP defense team",
      version: 1,
      createdAt: new Date("2026-11-15T00:00:00Z"),
      updatedAt: new Date("2026-11-15T00:00:00Z"),
      permissions: [{ permissionKey: "threats.view" }, { permissionKey: "threats.manage" }],
      _count: { members: 0 },
    });

    const createdByOwner = await createSysAdminGroup(
      { name: "Threat Operators", description: "IP defense team", permissions: ["threats.view", "threats.manage"] },
      { role: "OWNER", id: 1, username: "main_owner" }
    );
    expect(createdByOwner.name).toBe("Threat Operators");
    expect(prisma.sysAdminPmaAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "GROUP_CREATED", actorRole: "OWNER", actorUsername: "main_owner" }),
      })
    );

    // Secondary Owner (#2) must be rejected
    await expect(
      createSysAdminGroup(
        { name: "Unauthorized", permissions: ["telemetry.view"] },
        { role: "OWNER", id: 2, username: "second_owner" }
      )
    ).rejects.toMatchObject({ status: 403 });

    // Secondary SysAdmin (#2) must be rejected
    await expect(
      createSysAdminGroup(
        { name: "Unauthorized", permissions: ["telemetry.view"] },
        { role: "SYSADMIN", id: 2, username: "second_it" }
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it("enforces Mutual Root Protection: Main Owner cannot restrict or suspend Main SysAdmin", async () => {
    prisma.sysAdmin.findUnique.mockResolvedValue({
      id: 1,
      username: "root_it",
      status: "Active",
      accessGroupId: null,
      accessGroup: null,
      permissionOverrides: [],
    });

    await expect(
      updateSysAdminAccountAccess(
        1,
        { accessGroupId: null, overrides: [{ permissionKey: "telemetry.view", effect: "DENY" }] },
        { role: "OWNER", id: 1, username: "main_owner" }
      )
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      updateSysAdminAccountStatus(
        1,
        { status: "Suspended", reason: "Attempt downgrade" },
        { role: "OWNER", id: 1, username: "main_owner" }
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it("enforces Mutual Root Protection: Main SysAdmin cannot suspend or lock Main Owner", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "OWNER", status: "Active" });
    prisma.user.findFirst.mockResolvedValue({ id: 1 });

    await expect(
      updateAccountStatus("OWNER", 1, "Suspended", "root_it", "test")
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("validates dependency prerequisites, invalidates cache, emits socket notification, and records audit logs", async () => {
    prisma.sysAdmin.findUnique.mockResolvedValue({
      id: 2,
      username: "ops_admin",
      status: "Active",
      accessGroupId: null,
      accessGroup: null,
      permissionOverrides: [],
    });

    // Granting threats.manage without threats.view must fail 400
    await expect(
      updateSysAdminAccountAccess(
        2,
        {
          accessGroupId: null,
          overrides: [{ permissionKey: "threats.manage", effect: "GRANT" }],
        },
        { role: "SYSADMIN", id: 1, username: "root_it" }
      )
    ).rejects.toMatchObject({ status: 400 });

    // Valid grant succeeds, emits live socket refresh, and logs audit entry
    await updateSysAdminAccountAccess(
      2,
      {
        accessGroupId: null,
        overrides: [
          { permissionKey: "threats.view", effect: "GRANT" },
          { permissionKey: "threats.manage", effect: "GRANT" },
        ],
      },
      { role: "OWNER", id: 1, username: "main_owner" }
    );

    expect(notifySysAdminPermissionsChanged).toHaveBeenCalledWith([2]);
    expect(prisma.sysAdminPmaAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ACCOUNT_ACCESS_UPDATED",
          sysAdminId: 2,
          actorRole: "OWNER",
        }),
      })
    );
  });

  it("suspending a secondary IT Admin revokes sessions and disconnects sysadmin socket room", async () => {
    prisma.sysAdmin.findUnique.mockResolvedValue({
      id: 2,
      username: "ops_admin",
      status: "Active",
    });

    await updateSysAdminAccountStatus(
      2,
      { status: "Suspended", reason: "Offboarding" },
      { role: "SYSADMIN", id: 1, username: "root_it" }
    );

    expect(revokeAllForSubject).toHaveBeenCalledWith("SYSADMIN", 2, "SYSADMIN_STATUS_UPDATED");
    expect(disconnectAccount).toHaveBeenCalledWith(2, "SYSADMIN");
  });

  it("refuses deleting an access group that still has assigned members", async () => {
    prisma.sysAdminAccessGroup.findUnique.mockResolvedValue({
      id: 5,
      name: "DevOps",
      _count: { members: 2 },
    });

    await expect(
      deleteSysAdminGroup(5, { role: "SYSADMIN", id: 1, username: "root_it" })
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("Route middleware contracts", () => {
  function findLayer(router: any, path: string, method: string) {
    const stack = router.stack || [];
    return stack.find(
      (l: any) => l.route?.path === path && Boolean(l.route?.methods?.[method.toLowerCase()])
    );
  }

  it("enforces requireMainSysAdmin + verifyStepUpPassword on SysAdmin PMA write routes", () => {
    const createGroupLayer = findLayer(sysAdminRoutes, "/sysadmin/pma/groups", "POST");
    const updateAccountLayer = findLayer(sysAdminRoutes, "/sysadmin/pma/accounts/:id", "PUT");
    const statusLayer = findLayer(sysAdminRoutes, "/sysadmin/pma/accounts/:id/status", "PATCH");
    const meLayer = findLayer(sysAdminRoutes, "/sysadmin/pma/me", "GET");

    for (const layer of [createGroupLayer, updateAccountLayer, statusLayer]) {
      const names = layer.route.stack.map((s: any) => s.name);
      expect(names).toContain("requireMainSysAdmin");
      expect(names).toContain("verifyStepUpPassword");
    }

    const meNames = meLayer.route.stack.map((s: any) => s.name);
    expect(meNames).not.toContain("requireMainSysAdmin");
  });

  it("gates Owner-portal SysAdmin PMA routes behind requireMainOwner", () => {
    const ownerGroups = findLayer(accessRoutes, "/access/sysadmin/groups", "GET");
    const ownerAccountPut = findLayer(accessRoutes, "/access/sysadmin/accounts/:id", "PUT");

    expect(ownerGroups.route.stack.map((s: any) => s.name)).toContain("requireMainOwner");
    expect(ownerAccountPut.route.stack.map((s: any) => s.name)).toContain("requireMainOwner");
  });
});
