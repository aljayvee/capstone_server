import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "./ServiceError.js";
import {
  FULL_ACCESS_GROUP_NAME,
  PERMISSIONS,
  isPermissionKey,
  permissionKeysFor,
  scopeOfRole,
  type PermissionScope,
} from "../lib/permissions.js";
import { getEffectivePermissions, invalidatePermissions, resolvePermissions } from "../lib/permissionCache.js";
import { getMainOwnerId, invalidateMainOwner, isMainOwner } from "../lib/mainOwner.js";
import { notifyPermissionsChanged } from "../lib/socket.js";
import { accountAuditRepository, type CreateModificationLogInput } from "../repositories/accountAuditRepository.js";
import type {
  AccountAccessInput,
  CreateAccessGroupInput,
  UpdateAccessGroupInput,
} from "../validators/accessValidators.js";

/**
 * Access groups (RBAC) and the Main Owner's guards.
 *
 * Every route that reaches the group and account functions here is already
 * behind requireRole(["OWNER"]) and requireMainOwner, so they do not re-check
 * the caller. assertCanManageAccount is the exception: userService calls it
 * for the ordinary Users screen, which other Admins can reach.
 */

export interface AuditContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const VERIFIED_VIA = "MAIN_OWNER_SESSION";

function keysForScope(scope: PermissionScope, keys: readonly string[]): string[] {
  const unknown = keys.filter((key) => !isPermissionKey(key, scope));
  if (unknown.length > 0) {
    throw new ServiceError(400, `Not ${scope === "OWNER" ? "Admin" : "Dispatcher"} permissions: ${unknown.join(", ")}.`, {
      code: "UNKNOWN_PERMISSION",
      keys: unknown,
    });
  }
  // Catalog order, no duplicates.
  return PERMISSIONS.filter((p) => keys.includes(p.key)).map((p) => p.key);
}

function auditRows(
  rows: Array<Omit<CreateModificationLogInput, "ipAddress" | "userAgent" | "verifiedVia">>,
  ctx: AuditContext,
): CreateModificationLogInput[] {
  return rows.map((row) => ({
    ...row,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
    verifiedVia: VERIFIED_VIA,
  }));
}

/** The audit trail must not be what fails an access change that already landed. */
async function writeAudit(rows: CreateModificationLogInput[]): Promise<void> {
  try {
    await accountAuditRepository.createMany(rows);
  } catch (error) {
    logger.error("[Access] Could not write the audit rows for an access change:", error);
  }
}

function afterChange(userIds: number[]): void {
  invalidatePermissions(userIds);
  try {
    notifyPermissionsChanged(userIds);
  } catch (error) {
    logger.error("[Access] Could not notify accounts of an access change:", error);
  }
}

// ── The signed-in account's own access ─────────────────────────────────────

export async function getOwnPermissions(caller: { id: number; role: string }) {
  const effective = await getEffectivePermissions(caller.id, caller.role);
  if (!effective) throw new ServiceError(403, "This account has no access groups.");
  return effective;
}

// ── Catalog ─────────────────────────────────────────────────────────────────

export function getCatalog() {
  return {
    fullAccessName: FULL_ACCESS_GROUP_NAME,
    scopes: [
      { scope: "OWNER", label: "Admin" },
      { scope: "DISPATCHER", label: "Dispatcher" },
    ],
    permissions: PERMISSIONS,
  };
}

// ── Groups ──────────────────────────────────────────────────────────────────

const GROUP_SELECT = {
  id: true,
  name: true,
  description: true,
  scope: true,
  version: true,
  updatedAt: true,
  permissions: { select: { permissionKey: true } },
  _count: { select: { members: true } },
} satisfies Prisma.AccessGroupSelect;

type GroupRow = Prisma.AccessGroupGetPayload<{ select: typeof GROUP_SELECT }>;

function presentGroup(group: GroupRow) {
  const scope = group.scope as PermissionScope;
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    scope,
    version: group.version,
    updatedAt: group.updatedAt,
    // Keys that left the catalog are not shown, matching what they grant (nothing).
    permissions: resolvePermissions(scope, group.permissions.map((p) => p.permissionKey), []),
    memberCount: group._count.members,
  };
}

export async function listGroups() {
  const groups = await prisma.accessGroup.findMany({
    select: GROUP_SELECT,
    orderBy: [{ scope: "asc" }, { name: "asc" }],
  });
  return groups.map(presentGroup);
}

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new ServiceError(400, "Give the group a name.");
  if (trimmed.toLowerCase() === FULL_ACCESS_GROUP_NAME.toLowerCase()) {
    throw new ServiceError(400, `"${FULL_ACCESS_GROUP_NAME}" is the built-in group. Pick another name.`);
  }
  return trimmed;
}

function duplicateName(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createGroup(input: CreateAccessGroupInput, actingUserId: number) {
  const scope = input.scope;
  const permissions = keysForScope(scope, input.permissions);
  try {
    const group = await prisma.accessGroup.create({
      data: {
        name: cleanName(input.name),
        description: input.description?.trim() || null,
        scope,
        createdBy: actingUserId,
        updatedBy: actingUserId,
        permissions: { create: permissions.map((permissionKey) => ({ permissionKey })) },
      },
      select: GROUP_SELECT,
    });
    return presentGroup(group);
  } catch (error) {
    if (duplicateName(error)) throw new ServiceError(409, "A group with this name already exists.", { code: "DUPLICATE_NAME" });
    throw error;
  }
}

export async function updateGroup(
  groupId: number,
  input: UpdateAccessGroupInput,
  actingUserId: number,
  ctx: AuditContext = {},
) {
  const existing = await prisma.accessGroup.findUnique({ where: { id: groupId }, select: GROUP_SELECT });
  if (!existing) throw new ServiceError(404, "This group no longer exists.");
  const scope = existing.scope as PermissionScope;
  const before = presentGroup(existing);
  const permissions = input.permissions ? keysForScope(scope, input.permissions) : before.permissions;

  const conflict = async () => {
    const latest = await prisma.accessGroup.findUnique({ where: { id: groupId }, select: GROUP_SELECT });
    return new ServiceError(409, "Someone else changed this group. Reload to see their changes.", {
      code: "VERSION_CONFLICT",
      latest: latest ? presentGroup(latest) : null,
    });
  };
  if (existing.version !== input.version) throw await conflict();

  let memberIds: number[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      // The version guard and the write are one statement, so two Main Owner
      // tabs saving at once cannot both win.
      const { count } = await tx.accessGroup.updateMany({
        where: { id: groupId, version: input.version },
        data: {
          ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          version: { increment: 1 },
          updatedBy: actingUserId,
        },
      });
      if (count === 0) throw await conflict();
      if (input.permissions) {
        await tx.accessGroupPermission.deleteMany({ where: { groupId } });
        await tx.accessGroupPermission.createMany({
          data: permissions.map((permissionKey) => ({ groupId, permissionKey })),
        });
      }
      const members = await tx.user.findMany({ where: { accessGroupId: groupId }, select: { id: true } });
      memberIds = members.map((m) => m.id);
    });
  } catch (error) {
    if (duplicateName(error)) throw new ServiceError(409, "A group with this name already exists.", { code: "DUPLICATE_NAME" });
    throw error;
  }

  const permissionsChanged = permissions.join(",") !== before.permissions.join(",");
  if (permissionsChanged && memberIds.length > 0) {
    await writeAudit(
      auditRows(
        memberIds.map((userId) => ({
          role: scope,
          userId,
          fieldModified: `groupPermissions:${before.name}`,
          oldValue: before.permissions.join(", ") || "(none)",
          newValue: permissions.join(", ") || "(none)",
        })),
        ctx,
      ),
    );
  }
  afterChange(memberIds);

  const updated = await prisma.accessGroup.findUnique({ where: { id: groupId }, select: GROUP_SELECT });
  return presentGroup(updated!);
}

export async function deleteGroup(groupId: number) {
  const existing = await prisma.accessGroup.findUnique({ where: { id: groupId }, select: GROUP_SELECT });
  if (!existing) throw new ServiceError(404, "This group no longer exists.");
  if (existing._count.members > 0) {
    throw new ServiceError(
      409,
      `${existing._count.members} ${existing._count.members === 1 ? "account is" : "accounts are"} still in this group. Move them to another group first.`,
      { code: "GROUP_HAS_MEMBERS", memberCount: existing._count.members },
    );
  }
  try {
    await prisma.accessGroup.delete({ where: { id: groupId } });
  } catch (error) {
    // An account joined the group between the count and the delete: the FK is
    // RESTRICT, so the database refused rather than dropping it to full access.
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2003" || error.code === "P2014")) {
      throw new ServiceError(409, "An account was just added to this group. Move it to another group first.", {
        code: "GROUP_HAS_MEMBERS",
      });
    }
    throw error;
  }
  return { deleted: true };
}

// ── Accounts ────────────────────────────────────────────────────────────────

const ACCOUNT_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  accessGroupId: true,
  accessGroup: {
    select: { id: true, name: true, scope: true, permissions: { select: { permissionKey: true } } },
  },
  permissionOverrides: { select: { permissionKey: true, effect: true } },
} satisfies Prisma.UserSelect;

type AccountRow = Prisma.UserGetPayload<{ select: typeof ACCOUNT_SELECT }>;

function presentAccount(row: AccountRow, mainOwnerId: number | null) {
  const scope = scopeOfRole(row.role) as PermissionScope;
  const isMain = scope === "OWNER" && row.id === mainOwnerId;
  const group = !isMain && row.accessGroup && row.accessGroup.scope === scope ? row.accessGroup : null;
  const overrides = isMain
    ? []
    : row.permissionOverrides
        .filter((o) => isPermissionKey(o.permissionKey, scope))
        .map((o) => ({ permissionKey: o.permissionKey, effect: o.effect }));
  const groupKeys = group ? group.permissions.map((p) => p.permissionKey) : null;
  return {
    id: row.id,
    username: row.username,
    name: `${row.firstName} ${row.lastName}`.trim(),
    role: scope,
    status: row.status,
    isMainOwner: isMain,
    group: group ? { id: group.id, name: group.name } : { id: null, name: FULL_ACCESS_GROUP_NAME },
    overrides,
    groupPermissions: groupKeys === null ? permissionKeysFor(scope) : resolvePermissions(scope, groupKeys, []),
    effectivePermissions: isMain ? permissionKeysFor(scope) : resolvePermissions(scope, groupKeys, overrides),
  };
}

export async function listAccounts() {
  const [rows, mainOwnerId] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ["OWNER", "DISPATCHER"] } },
      select: ACCOUNT_SELECT,
      orderBy: [{ role: "asc" }, { firstName: "asc" }, { lastName: "asc" }],
    }),
    getMainOwnerId(),
  ]);
  const accounts = rows.map((row) => presentAccount(row, mainOwnerId));
  // The Main Owner first: the one row nothing here can change.
  return [...accounts.filter((a) => a.isMainOwner), ...accounts.filter((a) => !a.isMainOwner)];
}

export async function updateAccountAccess(
  userId: number,
  input: AccountAccessInput,
  actingUserId: number,
  ctx: AuditContext = {},
) {
  const [target, mainOwnerId] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: ACCOUNT_SELECT }),
    getMainOwnerId(),
  ]);
  if (!target) throw new ServiceError(404, "This account no longer exists.");
  const scope = scopeOfRole(target.role);
  if (!scope) throw new ServiceError(400, "Riders do not have access groups.");
  if (target.id === mainOwnerId) {
    throw new ServiceError(400, "The Main Owner always has full access, so it cannot be given a group or overrides.");
  }

  let groupName = FULL_ACCESS_GROUP_NAME;
  if (input.accessGroupId !== null) {
    const group = await prisma.accessGroup.findUnique({
      where: { id: input.accessGroupId },
      select: { id: true, name: true, scope: true },
    });
    if (!group) throw new ServiceError(404, "That group no longer exists.");
    if (group.scope !== scope) {
      throw new ServiceError(400, `"${group.name}" is a ${group.scope === "OWNER" ? "Admin" : "Dispatcher"} group, and this account is not.`);
    }
    groupName = group.name;
  }

  const overrideKeys = keysForScope(
    scope,
    input.overrides.map((o) => o.permissionKey),
  );
  const effectByKey = new Map(input.overrides.map((o) => [o.permissionKey, o.effect]));
  const overrides = overrideKeys.map((permissionKey) => ({ permissionKey, effect: effectByKey.get(permissionKey)! }));

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { accessGroupId: input.accessGroupId, updatedBy: actingUserId } }),
    prisma.userPermissionOverride.deleteMany({ where: { userId } }),
    prisma.userPermissionOverride.createMany({
      data: overrides.map((o) => ({ userId, permissionKey: o.permissionKey, effect: o.effect, createdBy: actingUserId })),
    }),
  ]);

  const before = presentAccount(target, mainOwnerId);
  const rows: Array<Omit<CreateModificationLogInput, "ipAddress" | "userAgent" | "verifiedVia">> = [];
  if (before.group.name !== groupName) {
    rows.push({ role: scope, userId, fieldModified: "accessGroup", oldValue: before.group.name, newValue: groupName });
  }
  const oldByKey = new Map(before.overrides.map((o) => [o.permissionKey, o.effect]));
  for (const key of new Set([...oldByKey.keys(), ...overrides.map((o) => o.permissionKey)])) {
    const oldEffect = oldByKey.get(key) ?? null;
    const newEffect = effectByKey.has(key) && overrideKeys.includes(key) ? effectByKey.get(key)! : null;
    if (oldEffect !== newEffect) {
      rows.push({
        role: scope,
        userId,
        fieldModified: `permissionOverride:${key}`,
        oldValue: oldEffect ?? "INHERIT",
        newValue: newEffect ?? "INHERIT",
      });
    }
  }
  await writeAudit(auditRows(rows, ctx));
  afterChange([userId]);

  const updated = await prisma.user.findUnique({ where: { id: userId }, select: ACCOUNT_SELECT });
  return presentAccount(updated!, mainOwnerId);
}

// ── Guards for the Users screen ─────────────────────────────────────────────

/**
 * Who may create or change an account through /users. Other Admins keep
 * dispatcher and rider accounts (behind users.manage on the route); Admin
 * accounts, and every move into or out of the Admin role, are the Main
 * Owner's. Without this, a restricted Admin could create a Full access Admin
 * and sign in as it.
 */
export async function assertCanManageAccount(
  actingUserId: number | undefined,
  target: { id: number; role: string } | null,
  nextRole?: string,
): Promise<void> {
  const acting = actingUserId ?? null;
  const mainOwnerId = await getMainOwnerId();
  const actingIsMain = acting !== null && acting === mainOwnerId;
  const touchesAdmin =
    String(target?.role ?? "").toUpperCase() === "OWNER" || String(nextRole ?? "").toUpperCase() === "OWNER";

  if (target && target.id === mainOwnerId && acting !== mainOwnerId) {
    throw new ServiceError(403, "Only the Main Owner can change the Main Owner's account.", { code: "MAIN_OWNER_ONLY" });
  }
  if (touchesAdmin && !actingIsMain && !(target && target.id === acting && !nextRole)) {
    throw new ServiceError(403, "Only the Main Owner can create or change Admin accounts.", { code: "MAIN_OWNER_ONLY" });
  }
  // A promotion to Admin of an account older than the Main Owner would make
  // that account the Main Owner (the lowest Admin id).
  if (
    target &&
    String(nextRole ?? "").toUpperCase() === "OWNER" &&
    String(target.role).toUpperCase() !== "OWNER" &&
    mainOwnerId !== null &&
    target.id < mainOwnerId
  ) {
    throw new ServiceError(
      409,
      "This account is older than the Main Owner, so making it an Admin would make it the Main Owner. Create a new Admin account instead.",
      { code: "WOULD_REPLACE_MAIN_OWNER" },
    );
  }
}

/** userService calls this after a role change lands. */
export async function onRoleChanged(userId: number): Promise<void> {
  // A group belongs to one role, so it cannot follow the account to another.
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { accessGroupId: null } }),
    prisma.userPermissionOverride.deleteMany({ where: { userId } }),
  ]);
  invalidateMainOwner();
  invalidatePermissions([userId]);
}

export { isMainOwner };

/** For the Users list: who the Main Owner is, and every group's name by id. */
export async function directoryAccess(): Promise<{ mainOwnerId: number | null; groupNames: Map<number, string> }> {
  const [mainOwnerId, groups] = await Promise.all([
    getMainOwnerId(),
    prisma.accessGroup.findMany({ select: { id: true, name: true } }),
  ]);
  return { mainOwnerId, groupNames: new Map(groups.map((g) => [g.id, g.name])) };
}
