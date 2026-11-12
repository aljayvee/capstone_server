import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Access groups (RBAC), 2026-11-04:
 * - effective permissions are the group (or Full access) plus GRANT minus DENY;
 * - the Main Owner (lowest OWNER id) always has everything and alone manages
 *   access and Admin accounts;
 * - requirePermission gates only callers of its own role, fails closed, and
 *   logs every refusal;
 * - Kuya Sugo only offers and runs tools the caller's group allows.
 */

const { prisma, notifyPermissionsChanged, logRefusal } = vi.hoisted(() => {
  const prisma: any = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(async () => ({})) },
    accessGroup: { findUnique: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    accessGroupPermission: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
    userPermissionOverride: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
    accountModificationLog: { createMany: vi.fn(async () => ({ count: 0 })) },
    errand: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
  };
  prisma.$transaction = vi.fn(async (arg: any) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg)));
  return { prisma, notifyPermissionsChanged: vi.fn(), logRefusal: vi.fn() };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma }));
vi.mock("../src/lib/socket.js", () => ({ notifyPermissionsChanged }));
vi.mock("../src/lib/authzLog.js", () => ({ logRefusal }));
vi.mock("../src/config/env.js", async (orig) => ({
  ...(await orig<typeof import("../src/config/env.js")>()),
  JWT_SECRET: "test-secret",
}));
vi.mock("../src/lib/blocklistCache.js", () => ({ isRevoked: vi.fn(async () => false) }));
vi.mock("../src/services/sysAdminDevOpsService.js", () => ({ getKuyaSugoEnabled: () => true }));

import { resolvePermissions, getEffectivePermissions, invalidatePermissions } from "../src/lib/permissionCache.js";
import { getMainOwnerId, invalidateMainOwner } from "../src/lib/mainOwner.js";
import { permissionKeysFor } from "../src/lib/permissions.js";
import { requireMainOwner, requirePermission } from "../src/middleware/auth.js";
import { assertCanManageAccount, updateAccountAccess } from "../src/services/accessService.js";
import { chatWithOwnerCopilot } from "../src/services/ownerCopilotService.js";

const ALL_ADMIN = permissionKeysFor("OWNER");

/** An account row as getEffectivePermissions selects it. */
function account(id: number, role: string, groupKeys: string[] | null, overrides: Array<{ permissionKey: string; effect: string }> = []) {
  return {
    id,
    role,
    accessGroup: groupKeys
      ? { id: 50, name: "Reports only", scope: role, permissions: groupKeys.map((permissionKey) => ({ permissionKey })) }
      : null,
    permissionOverrides: overrides,
  };
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateMainOwner();
  invalidatePermissions();
  // id 1 is the Main Owner, as on production.
  prisma.user.findFirst.mockResolvedValue({ id: 1 });
});

describe("resolvePermissions", () => {
  it("gives an account with no group every key of its role", () => {
    expect(resolvePermissions("OWNER", null, [])).toEqual(ALL_ADMIN);
  });

  it("adds GRANT and removes DENY overrides on top of the group", () => {
    const keys = resolvePermissions("OWNER", ["reports.view", "dashboard.view"], [
      { permissionKey: "reports.print", effect: "GRANT" },
      { permissionKey: "dashboard.view", effect: "DENY" },
    ]);
    expect(keys).toEqual(["reports.view", "reports.print"]);
  });

  it("ignores keys outside the catalog and keys of the other role", () => {
    const keys = resolvePermissions("OWNER", ["reports.view", "access.manage", "payments.refund"], [
      { permissionKey: "errands.cancel", effect: "GRANT" },
      { permissionKey: "made.up", effect: "GRANT" },
    ]);
    expect(keys).toEqual(["reports.view"]);
  });
});

describe("getMainOwnerId", () => {
  it("is the lowest id among OWNER accounts only, so a dispatcher with a lower id never counts", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 4 });
    expect(await getMainOwnerId()).toBe(4);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: "OWNER" }, orderBy: { id: "asc" } })
    );
  });
});

describe("getEffectivePermissions", () => {
  it("gives the Main Owner everything even if a group and denies were somehow stored", async () => {
    prisma.user.findUnique.mockResolvedValue(
      account(1, "OWNER", ["reports.view"], [{ permissionKey: "rates.manage", effect: "DENY" }])
    );
    const effective = await getEffectivePermissions(1, "OWNER");
    expect(effective?.isMainOwner).toBe(true);
    expect(effective?.permissions).toEqual(ALL_ADMIN);
  });

  it("applies the group and overrides for any other Admin", async () => {
    prisma.user.findUnique.mockResolvedValue(
      account(4, "OWNER", ["reports.view"], [{ permissionKey: "tracking.view", effect: "GRANT" }])
    );
    const effective = await getEffectivePermissions(4, "OWNER");
    expect(effective?.group).toEqual({ id: 50, name: "Reports only" });
    expect(effective?.permissions).toEqual(["reports.view", "tracking.view"]);
  });

  it("grants nothing while the token still carries a role the account no longer has", async () => {
    prisma.user.findUnique.mockResolvedValue(account(9, "RIDER", null));
    expect((await getEffectivePermissions(9, "DISPATCHER"))?.permissions).toEqual([]);
  });

  it("serves repeat checks from the cache until a write invalidates it", async () => {
    prisma.user.findUnique.mockResolvedValue(account(9, "DISPATCHER", ["queue.view"]));
    await getEffectivePermissions(9, "DISPATCHER");
    await getEffectivePermissions(9, "DISPATCHER");
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);

    prisma.user.findUnique.mockResolvedValue(account(9, "DISPATCHER", ["queue.view", "errands.assign"]));
    invalidatePermissions([9]);
    expect((await getEffectivePermissions(9, "DISPATCHER"))?.permissions).toContain("errands.assign");
  });
});

describe("requirePermission", () => {
  it("refuses an unknown key when the route is built, not silently at request time", () => {
    expect(() => requirePermission("reports.veiw")).toThrow(/unknown permission key/);
    expect(() => requirePermission({ OWNER: "payments.refund" })).toThrow(/DISPATCHER key/);
  });

  it("passes callers of the other role through untouched", async () => {
    const next = vi.fn();
    await requirePermission("payments.refund")({ user: { id: 4, role: "OWNER" } } as any, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("answers 403 with the permission named, and logs the refusal", async () => {
    prisma.user.findUnique.mockResolvedValue(account(9, "DISPATCHER", ["queue.view"]));
    const res = mockRes();
    const next = vi.fn();
    await requirePermission("payments.refund")({ user: { id: 9, role: "DISPATCHER" } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PERMISSION_DENIED", permission: "payments.refund" })
    );
    expect(logRefusal).toHaveBeenCalledWith(expect.anything(), 403, "access group lacks payments.refund");
  });

  it("lets a granted caller through", async () => {
    prisma.user.findUnique.mockResolvedValue(
      account(9, "DISPATCHER", ["queue.view"], [{ permissionKey: "payments.refund", effect: "GRANT" }])
    );
    const next = vi.fn();
    await requirePermission("payments.refund")({ user: { id: 9, role: "DISPATCHER" } } as any, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("fails closed with a 503 when access cannot be read", async () => {
    prisma.user.findUnique.mockRejectedValue(new Error("db down"));
    const res = mockRes();
    const next = vi.fn();
    await requirePermission("reports.view")({ user: { id: 4, role: "OWNER" } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe("requireMainOwner", () => {
  it("lets the Main Owner through and refuses every other Admin", async () => {
    const next = vi.fn();
    await requireMainOwner({ user: { id: 1, role: "OWNER" } } as any, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);

    const res = mockRes();
    await requireMainOwner({ user: { id: 4, role: "OWNER" } } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "MAIN_OWNER_ONLY" }));
  });
});

describe("assertCanManageAccount (the Users screen)", () => {
  const dispatcher = { id: 9, role: "DISPATCHER" };
  const otherAdmin = { id: 6, role: "OWNER" };

  it("lets another Admin create and edit dispatchers", async () => {
    await expect(assertCanManageAccount(4, null, "DISPATCHER")).resolves.toBeUndefined();
    await expect(assertCanManageAccount(4, dispatcher)).resolves.toBeUndefined();
  });

  it("refuses another Admin creating an Admin, promoting to Admin or editing an Admin", async () => {
    await expect(assertCanManageAccount(4, null, "owner")).rejects.toMatchObject({ status: 403 });
    await expect(assertCanManageAccount(4, dispatcher, "OWNER")).rejects.toMatchObject({ status: 403 });
    await expect(assertCanManageAccount(4, otherAdmin)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses anyone but the Main Owner touching the Main Owner's account", async () => {
    await expect(assertCanManageAccount(4, { id: 1, role: "OWNER" })).rejects.toMatchObject({ status: 403 });
    await expect(assertCanManageAccount(1, { id: 1, role: "OWNER" })).resolves.toBeUndefined();
  });

  it("lets the Main Owner manage Admins, but not promote an account older than itself", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 4 });
    await expect(assertCanManageAccount(4, { id: 9, role: "DISPATCHER" }, "OWNER")).resolves.toBeUndefined();
    await expect(assertCanManageAccount(4, { id: 2, role: "DISPATCHER" }, "OWNER")).rejects.toMatchObject({
      status: 409,
      details: { code: "WOULD_REPLACE_MAIN_OWNER" },
    });
  });
});

describe("updateAccountAccess (Settings > Account access)", () => {
  const dispatcherRow = {
    id: 9,
    username: "jo",
    firstName: "Jo",
    lastName: "Cruz",
    role: "DISPATCHER",
    status: "Active",
    accessGroupId: null,
    accessGroup: null,
    permissionOverrides: [],
  };

  it("refuses to give the Main Owner a group or overrides", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...dispatcherRow, id: 1, role: "OWNER" });
    await expect(updateAccountAccess(1, { accessGroupId: 50, overrides: [] }, 1)).rejects.toMatchObject({ status: 400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a group of the other role", async () => {
    prisma.user.findUnique.mockResolvedValue(dispatcherRow);
    prisma.accessGroup.findUnique.mockResolvedValue({ id: 50, name: "Reports only", scope: "OWNER" });
    await expect(updateAccountAccess(9, { accessGroupId: 50, overrides: [] }, 1)).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an override key the role does not have", async () => {
    prisma.user.findUnique.mockResolvedValue(dispatcherRow);
    await expect(
      updateAccountAccess(9, { accessGroupId: null, overrides: [{ permissionKey: "rates.manage", effect: "GRANT" }] }, 1)
    ).rejects.toMatchObject({ status: 400, details: { code: "UNKNOWN_PERMISSION" } });
  });

  it("saves, audits each change, and tells the account its access changed", async () => {
    prisma.user.findUnique.mockResolvedValue(dispatcherRow);
    await updateAccountAccess(
      9,
      { accessGroupId: null, overrides: [{ permissionKey: "payments.refund", effect: "DENY" }] },
      1,
      { ipAddress: "203.0.113.5", userAgent: "test" }
    );
    expect(prisma.userPermissionOverride.createMany).toHaveBeenCalledWith({
      data: [{ userId: 9, permissionKey: "payments.refund", effect: "DENY", createdBy: 1 }],
    });
    expect(prisma.accountModificationLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 9,
          fieldModified: "permissionOverride:payments.refund",
          oldValue: "INHERIT",
          newValue: "DENY",
          verifiedVia: "MAIN_OWNER_SESSION",
        }),
      ],
    });
    expect(notifyPermissionsChanged).toHaveBeenCalledWith([9]);
  });
});

describe("Kuya Sugo respects the caller's access group", () => {
  it("offers no tool the caller lacks and refuses one the model asks for anyway", async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    // An Admin whose group has only rates.manage: no data tool at all.
    prisma.user.findUnique.mockResolvedValue(account(4, "OWNER", ["rates.manage"]));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            { content: { role: "model", parts: [{ functionCall: { name: "getSalesPulse", args: {} } }] } },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { role: "model", parts: [{ text: "I cannot see sales." }] } }] }),
      });
    global.fetch = fetchMock as any;

    try {
      await chatWithOwnerCopilot([{ role: "user", content: "What are today's sales?" }], undefined, {
        id: 4,
        role: "OWNER",
      });
      const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(firstBody.tools).toBeUndefined();
      const secondBody = JSON.stringify(JSON.parse(fetchMock.mock.calls[1][1].body));
      expect(secondBody).toContain("does not include the data this tool returns");
      expect(prisma.errand.findMany).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    }
  });
});
