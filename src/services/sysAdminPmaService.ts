import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { isMainOwner } from "../lib/mainOwner.js";
import { getMainSysAdminId, isMainSysAdmin } from "../lib/mainSysAdmin.js";
import {
  ALL_SYSADMIN_PERMISSION_KEYS,
  READ_ONLY_BASELINE_KEYS,
  SYSADMIN_PERMISSIONS,
  SYSADMIN_PERMISSION_AREAS,
  getSysAdminPermission,
  missingSysAdminRequires,
} from "../lib/sysAdminPermissions.js";
import {
  invalidateSysAdminGroupMembers,
  invalidateSysAdminPermissions,
  resolveSysAdminPermissions,
} from "../lib/sysAdminPermissionCache.js";
import { disconnectAccount, notifySessionRevoked, notifySysAdminPermissionsChanged } from "../lib/socket.js";
import { revokeAllForSubject } from "./sessionService.js";
import { ServiceError } from "./ServiceError.js";

export interface SysAdminPmaActor {
  role: "SYSADMIN" | "OWNER";
  id: number;
  username: string;
}

export interface SysAdminGroupInput {
  name: string;
  description?: string | null;
  permissions: string[];
}

export interface SysAdminOverrideEntry {
  permissionKey: string;
  effect: "GRANT" | "DENY";
}

function isUniqueError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "P2002");
}

function validatePermissionList(keys: string[]): void {
  const unknown = keys.filter((k) => !getSysAdminPermission(k));
  if (unknown.length > 0) {
    throw new ServiceError(400, `Unknown SysAdmin permission key: ${unknown.join(", ")}.`);
  }
  const missing = missingSysAdminRequires(keys);
  if (missing.length > 0) {
    const first = missing[0];
    const keyLabel = getSysAdminPermission(first.key)?.label ?? first.key;
    const reqLabel = getSysAdminPermission(first.requires)?.label ?? first.requires;
    throw new ServiceError(
      400,
      `"${keyLabel}" requires "${reqLabel}" to be enabled as well.`,
      { code: "MISSING_PERMISSION_DEPENDENCY", key: first.key, requires: first.requires }
    );
  }
}

export async function assertSysAdminPmaGovernance(actor: SysAdminPmaActor): Promise<void> {
  if (actor.role === "SYSADMIN") {
    if (await isMainSysAdmin(actor.id, "SYSADMIN")) return;
  } else if (actor.role === "OWNER") {
    if (await isMainOwner(actor.id, "OWNER")) return;
  }
  throw new ServiceError(
    403,
    "Only the Main SysAdmin or Main Owner can manage SysAdmin access groups and permissions.",
    { code: "GOVERNANCE_ROOT_ONLY" }
  );
}

export function getSysAdminPermissionCatalog() {
  return {
    areas: [...SYSADMIN_PERMISSION_AREAS],
    baselineKeys: [...READ_ONLY_BASELINE_KEYS],
    allKeys: [...ALL_SYSADMIN_PERMISSION_KEYS],
    permissions: SYSADMIN_PERMISSIONS.map((p) => ({
      key: p.key,
      area: p.area,
      label: p.label,
      note: p.note,
      requires: p.requires ? [...p.requires] : [],
      baselineReadOnly: Boolean(p.baselineReadOnly),
    })),
  };
}

export async function listSysAdminGroups() {
  const groups = await prisma.sysAdminAccessGroup.findMany({
    orderBy: [{ name: "asc" }],
    include: {
      permissions: { select: { permissionKey: true } },
      _count: { select: { members: true } },
    },
  });

  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    version: g.version,
    permissions: g.permissions.map((p) => p.permissionKey),
    memberCount: g._count.members,
    createdByActorRole: g.createdByActorRole,
    updatedByActorRole: g.updatedByActorRole,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  }));
}

async function recordPmaAuditMirror(params: {
  actor: SysAdminPmaActor;
  fieldModified: string;
  oldValue: string | null;
  newValue: string | null;
}) {
  try {
    const actorTag = params.actor.role === "OWNER" ? "MAIN_OWNER_PMA" : "MAIN_SYSADMIN_PMA";
    await prisma.accountModificationLog.create({
      data: {
        role: "SYSADMIN",
        userId: null,
        customerId: null,
        fieldModified: params.fieldModified,
        oldValue: params.oldValue,
        newValue: params.newValue,
        verifiedVia: `${actorTag}:${params.actor.username}`,
      },
    });
  } catch (err) {
    logger.warn("[SysAdminPMA] Failed to mirror PMA audit row to account_modification_logs:", err);
  }
}

export async function createSysAdminGroup(input: SysAdminGroupInput, actor: SysAdminPmaActor) {
  await assertSysAdminPmaGovernance(actor);
  validatePermissionList(input.permissions);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const group = await tx.sysAdminAccessGroup.create({
        data: {
          name: input.name.trim(),
          description: input.description ? input.description.trim() : null,
          createdByActorRole: actor.role,
          createdByActorId: actor.id,
          updatedByActorRole: actor.role,
          updatedByActorId: actor.id,
        },
      });

      if (input.permissions.length > 0) {
        await tx.sysAdminAccessGroupPermission.createMany({
          data: input.permissions.map((permissionKey) => ({
            groupId: group.id,
            permissionKey,
          })),
        });
      }

      await tx.sysAdminPmaAuditLog.create({
        data: {
          action: "GROUP_CREATED",
          groupId: group.id,
          groupName: group.name,
          actorRole: actor.role,
          actorId: actor.id,
          actorUsername: actor.username,
          fieldModified: "sysadmin_access_group",
          oldValue: null,
          newValue: JSON.stringify({
            name: group.name,
            permissions: input.permissions,
          }),
        },
      });

      return group;
    });

    await recordPmaAuditMirror({
      actor,
      fieldModified: "sysadmin_access_group_created",
      oldValue: null,
      newValue: `${created.name} (${input.permissions.length} permissions)`,
    });

    return {
      id: created.id,
      name: created.name,
      description: created.description,
      version: created.version,
      permissions: [...input.permissions],
      memberCount: 0,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  } catch (err: unknown) {
    if (isUniqueError(err)) {
      throw new ServiceError(409, `A SysAdmin access group named "${input.name.trim()}" already exists.`);
    }
    throw err;
  }
}

export async function updateSysAdminGroup(
  groupId: number,
  input: SysAdminGroupInput & { version: number },
  actor: SysAdminPmaActor
) {
  await assertSysAdminPmaGovernance(actor);
  validatePermissionList(input.permissions);

  const existing = await prisma.sysAdminAccessGroup.findUnique({
    where: { id: groupId },
    include: {
      permissions: { select: { permissionKey: true } },
      members: { select: { id: true } },
    },
  });

  if (!existing) {
    throw new ServiceError(404, "SysAdmin access group not found.");
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const res = await tx.sysAdminAccessGroup.updateMany({
        where: { id: groupId, version: input.version },
        data: {
          name: input.name.trim(),
          description: input.description ? input.description.trim() : null,
          version: { increment: 1 },
          updatedByActorRole: actor.role,
          updatedByActorId: actor.id,
        },
      });

      if (res.count === 0) {
        throw new ServiceError(
          409,
          "Someone else saved changes to this access group. Reload and try again.",
          { code: "VERSION_CONFLICT" }
        );
      }

      await tx.sysAdminAccessGroupPermission.deleteMany({ where: { groupId } });
      if (input.permissions.length > 0) {
        await tx.sysAdminAccessGroupPermission.createMany({
          data: input.permissions.map((permissionKey) => ({ groupId, permissionKey })),
        });
      }

      const prevKeys = existing.permissions.map((p) => p.permissionKey).sort();
      const nextKeys = [...input.permissions].sort();

      await tx.sysAdminPmaAuditLog.create({
        data: {
          action: "GROUP_UPDATED",
          groupId,
          groupName: input.name.trim(),
          actorRole: actor.role,
          actorId: actor.id,
          actorUsername: actor.username,
          fieldModified: "sysadmin_access_group",
          oldValue: JSON.stringify({ name: existing.name, permissions: prevKeys }),
          newValue: JSON.stringify({ name: input.name.trim(), permissions: nextKeys }),
        },
      });

      return tx.sysAdminAccessGroup.findUniqueOrThrow({
        where: { id: groupId },
        include: {
          permissions: { select: { permissionKey: true } },
          _count: { select: { members: true } },
        },
      });
    });

    const memberIds = existing.members.map((m) => m.id);
    invalidateSysAdminGroupMembers(groupId);
    for (const id of memberIds) {
      invalidateSysAdminPermissions(id);
    }
    notifySysAdminPermissionsChanged(memberIds);

    await recordPmaAuditMirror({
      actor,
      fieldModified: "sysadmin_access_group_updated",
      oldValue: existing.name,
      newValue: `${updated.name} (${updated.permissions.length} permissions)`,
    });

    return {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      version: updated.version,
      permissions: updated.permissions.map((p) => p.permissionKey),
      memberCount: updated._count.members,
      updatedAt: updated.updatedAt.toISOString(),
    };
  } catch (err: unknown) {
    if (err instanceof ServiceError) throw err;
    if (isUniqueError(err)) {
      throw new ServiceError(409, `A SysAdmin access group named "${input.name.trim()}" already exists.`);
    }
    throw err;
  }
}

export async function deleteSysAdminGroup(groupId: number, actor: SysAdminPmaActor) {
  await assertSysAdminPmaGovernance(actor);

  const existing = await prisma.sysAdminAccessGroup.findUnique({
    where: { id: groupId },
    include: { _count: { select: { members: true } } },
  });

  if (!existing) {
    throw new ServiceError(404, "SysAdmin access group not found.");
  }

  if (existing._count.members > 0) {
    throw new ServiceError(
      409,
      `Cannot delete "${existing.name}" while ${existing._count.members} IT Admin account(s) belong to it. Reassign them first.`,
      { code: "GROUP_HAS_MEMBERS", memberCount: existing._count.members }
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.sysAdminAccessGroup.delete({ where: { id: groupId } });
    await tx.sysAdminPmaAuditLog.create({
      data: {
        action: "GROUP_DELETED",
        groupId: null,
        groupName: existing.name,
        actorRole: actor.role,
        actorId: actor.id,
        actorUsername: actor.username,
        fieldModified: "sysadmin_access_group",
        oldValue: JSON.stringify({ id: existing.id, name: existing.name }),
        newValue: null,
      },
    });
  });

  invalidateSysAdminGroupMembers(groupId);
  await recordPmaAuditMirror({
    actor,
    fieldModified: "sysadmin_access_group_deleted",
    oldValue: existing.name,
    newValue: null,
  });
  return { deleted: true, id: groupId };
}

export async function listSysAdminAccounts() {
  const [rows, mainSysAdminId] = await Promise.all([
    prisma.sysAdmin.findMany({
      orderBy: [{ id: "asc" }],
      select: {
        id: true,
        username: true,
        email: true,
        nickname: true,
        firstName: true,
        middleName: true,
        lastName: true,
        status: true,
        enforceTwoFactor: true,
        lastLoginAt: true,
        createdAt: true,
        accessGroupId: true,
        accessGroup: {
          select: {
            id: true,
            name: true,
            permissions: { select: { permissionKey: true } },
          },
        },
        permissionOverrides: {
          select: { permissionKey: true, effect: true },
        },
      },
    }),
    getMainSysAdminId(),
  ]);

  return rows.map((row) => {
    const isRoot = row.id === mainSysAdminId;
    const groupKeys = row.accessGroup ? row.accessGroup.permissions.map((p) => p.permissionKey) : null;
    const overrides = row.permissionOverrides.map((o) => ({
      permissionKey: o.permissionKey,
      effect: o.effect as "GRANT" | "DENY",
    }));

    return {
      id: row.id,
      username: row.username,
      email: row.email,
      nickname: row.nickname,
      firstName: row.firstName,
      middleName: row.middleName,
      lastName: row.lastName,
      status: row.status,
      mfaEnabled: row.enforceTwoFactor,
      lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      isMainSysAdmin: isRoot,
      accessGroupId: isRoot ? null : row.accessGroupId,
      accessGroupName: isRoot ? null : (row.accessGroup?.name ?? null),
      baselineName: isRoot
        ? "Main SysAdmin (Full access)"
        : (row.accessGroup?.name ?? "Read-Only Monitoring (Default)"),
      overrides: isRoot ? [] : overrides,
      effectivePermissions: resolveSysAdminPermissions(groupKeys, overrides, isRoot),
    };
  });
}

export async function updateSysAdminAccountAccess(
  targetId: number,
  input: { accessGroupId: number | null; overrides: SysAdminOverrideEntry[] },
  actor: SysAdminPmaActor
) {
  await assertSysAdminPmaGovernance(actor);

  const [target, mainSysAdminId] = await Promise.all([
    prisma.sysAdmin.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        username: true,
        accessGroupId: true,
        accessGroup: { select: { id: true, name: true } },
        permissionOverrides: { select: { permissionKey: true, effect: true } },
      },
    }),
    getMainSysAdminId(),
  ]);

  if (!target) {
    throw new ServiceError(404, "IT Administrator account not found.");
  }

  if (target.id === mainSysAdminId) {
    throw new ServiceError(
      403,
      "Root Protection: The Main SysAdmin account retains permanent full access and cannot be restricted or reassigned.",
      { code: "MAIN_SYSADMIN_PROTECTED" }
    );
  }

  // Validate overrides & duplicates
  const seenKeys = new Set<string>();
  for (const ov of input.overrides) {
    if (!getSysAdminPermission(ov.permissionKey)) {
      throw new ServiceError(400, `Unknown SysAdmin permission key: ${ov.permissionKey}.`);
    }
    if (seenKeys.has(ov.permissionKey)) {
      throw new ServiceError(400, `Duplicate override for permission: ${ov.permissionKey}.`);
    }
    seenKeys.add(ov.permissionKey);
  }

  let groupKeys: string[] | null = null;
  let newGroupName = "Read-Only Monitoring (Default)";

  if (input.accessGroupId !== null) {
    const group = await prisma.sysAdminAccessGroup.findUnique({
      where: { id: input.accessGroupId },
      include: { permissions: { select: { permissionKey: true } } },
    });
    if (!group) {
      throw new ServiceError(404, "Selected SysAdmin access group does not exist.");
    }
    groupKeys = group.permissions.map((p) => p.permissionKey);
    newGroupName = group.name;
  }

  // Prune redundant overrides that match the base group (or Read-Only baseline when null)
  const baseSet = new Set(groupKeys ?? READ_ONLY_BASELINE_KEYS);
  const meaningfulOverrides = input.overrides.filter((ov) =>
    ov.effect === "GRANT" ? !baseSet.has(ov.permissionKey) : baseSet.has(ov.permissionKey)
  );

  const resultingEffective = resolveSysAdminPermissions(groupKeys, meaningfulOverrides, false);
  const missing = missingSysAdminRequires(resultingEffective);
  if (missing.length > 0) {
    const first = missing[0];
    const keyLabel = getSysAdminPermission(first.key)?.label ?? first.key;
    const reqLabel = getSysAdminPermission(first.requires)?.label ?? first.requires;
    throw new ServiceError(
      400,
      `Effective permissions cannot include "${keyLabel}" without "${reqLabel}".`,
      { code: "MISSING_PERMISSION_DEPENDENCY", key: first.key, requires: first.requires }
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.sysAdmin.update({
      where: { id: targetId },
      data: { accessGroupId: input.accessGroupId },
    });

    await tx.sysAdminPermissionOverride.deleteMany({ where: { sysAdminId: targetId } });
    if (meaningfulOverrides.length > 0) {
      await tx.sysAdminPermissionOverride.createMany({
        data: meaningfulOverrides.map((ov) => ({
          sysAdminId: targetId,
          permissionKey: ov.permissionKey,
          effect: ov.effect,
          createdByActorRole: actor.role,
          createdByActorId: actor.id,
        })),
      });
    }

    await tx.sysAdminPmaAuditLog.create({
      data: {
        action: "ACCOUNT_ACCESS_UPDATED",
        sysAdminId: targetId,
        targetUsername: target.username,
        groupId: input.accessGroupId,
        groupName: newGroupName,
        actorRole: actor.role,
        actorId: actor.id,
        actorUsername: actor.username,
        fieldModified: "sysadmin_access",
        oldValue: JSON.stringify({
          group: target.accessGroup?.name ?? "Read-Only Monitoring (Default)",
          overrides: target.permissionOverrides,
        }),
        newValue: JSON.stringify({
          group: newGroupName,
          overrides: meaningfulOverrides,
        }),
      },
    });
  });

  invalidateSysAdminPermissions(targetId);
  notifySysAdminPermissionsChanged([targetId]);

  await recordPmaAuditMirror({
    actor,
    fieldModified: `sysadmin_access:${target.username}`,
    oldValue: `${target.accessGroup?.name ?? "Read-Only Monitoring (Default)"} (${target.permissionOverrides.length} overrides)`,
    newValue: `${newGroupName} (${meaningfulOverrides.length} overrides)`,
  });

  logger.info(
    `[SysAdminPMA] ${actor.role} #${actor.id} (${actor.username}) updated access for SysAdmin #${targetId} (${target.username}) -> ${newGroupName}`
  );

  return {
    sysAdminId: targetId,
    accessGroupId: input.accessGroupId,
    baselineName: newGroupName,
    overrides: meaningfulOverrides,
    effectivePermissions: resultingEffective,
  };
}

export async function updateSysAdminAccountStatus(
  targetId: number,
  input: { status: "Active" | "Suspended" | "Inactive"; reason?: string },
  actor: SysAdminPmaActor
) {
  await assertSysAdminPmaGovernance(actor);

  const [target, mainSysAdminId] = await Promise.all([
    prisma.sysAdmin.findUnique({
      where: { id: targetId },
      select: { id: true, username: true, status: true },
    }),
    getMainSysAdminId(),
  ]);

  if (!target) {
    throw new ServiceError(404, "IT Administrator account not found.");
  }

  if (target.id === mainSysAdminId) {
    throw new ServiceError(
      403,
      "Root Protection: The Main SysAdmin account cannot be suspended or deactivated.",
      { code: "MAIN_SYSADMIN_PROTECTED" }
    );
  }

  if (target.status === input.status) {
    return { sysAdminId: targetId, status: target.status, changed: false };
  }

  await prisma.$transaction(async (tx) => {
    await tx.sysAdmin.update({
      where: { id: targetId },
      data: { status: input.status },
    });

    await tx.sysAdminPmaAuditLog.create({
      data: {
        action: "ACCOUNT_STATUS_UPDATED",
        sysAdminId: targetId,
        targetUsername: target.username,
        actorRole: actor.role,
        actorId: actor.id,
        actorUsername: actor.username,
        fieldModified: "status",
        oldValue: target.status,
        newValue: input.reason ? `${input.status} (${input.reason})` : input.status,
      },
    });
  });

  if (input.status !== "Active") {
    await revokeAllForSubject("SYSADMIN", targetId, "SYSADMIN_STATUS_UPDATED").catch((err) => {
      logger.warn(`[SysAdminPMA] Failed to revoke sessions for SysAdmin #${targetId}:`, err);
    });
    notifySessionRevoked(
      targetId,
      { reason: "SYSADMIN_STATUS_UPDATED" },
      "SYSADMIN"
    );
    disconnectAccount(targetId, "SYSADMIN");
  }

  invalidateSysAdminPermissions(targetId);
  notifySysAdminPermissionsChanged([targetId]);

  await recordPmaAuditMirror({
    actor,
    fieldModified: `sysadmin_status:${target.username}`,
    oldValue: target.status,
    newValue: input.reason ? `${input.status} (${input.reason})` : input.status,
  });

  return { sysAdminId: targetId, status: input.status, changed: true };
}

export async function listSysAdminPmaAuditLogs(params: { page: number; limit: number }) {
  const skip = (params.page - 1) * params.limit;
  const [total, logs] = await Promise.all([
    prisma.sysAdminPmaAuditLog.count(),
    prisma.sysAdminPmaAuditLog.findMany({
      orderBy: [{ createdAt: "desc" }],
      skip,
      take: params.limit,
    }),
  ]);

  return {
    total,
    page: params.page,
    limit: params.limit,
    totalPages: Math.max(1, Math.ceil(total / params.limit)),
    logs: logs.map((l) => ({
      id: l.id,
      action: l.action,
      sysAdminId: l.sysAdminId,
      targetUsername: l.targetUsername,
      groupId: l.groupId,
      groupName: l.groupName,
      actorRole: l.actorRole,
      actorId: l.actorId,
      actorUsername: l.actorUsername,
      fieldModified: l.fieldModified,
      oldValue: l.oldValue,
      newValue: l.newValue,
      createdAt: l.createdAt.toISOString(),
    })),
  };
}
