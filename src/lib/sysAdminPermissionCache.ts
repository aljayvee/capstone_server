import { LRUCache } from "lru-cache";
import { prisma } from "./prisma.js";
import { getMainSysAdminId } from "./mainSysAdmin.js";
import {
  ALL_SYSADMIN_PERMISSION_KEYS,
  READ_ONLY_BASELINE_KEYS,
  SYSADMIN_PERMISSIONS,
  getSysAdminPermission,
} from "./sysAdminPermissions.js";

/**
 * Effective SysAdmin permission resolver and isolated in-memory cache.
 * Strictly separated from `permissionCache.ts` (User table IDs) because
 * `tbl_sys_admin` has its own AUTO_INCREMENT sequence starting at 1.
 */

export interface EffectiveSysAdminPermissions {
  sysAdminId: number;
  isMainSysAdmin: boolean;
  groupId: number | null;
  groupName: string | null;
  baselineName: string;
  permissions: string[];
}

export interface SysAdminOverrideInput {
  permissionKey: string;
  effect: "GRANT" | "DENY" | string;
}

const cache = new LRUCache<number, EffectiveSysAdminPermissions>({
  max: 500,
  ttl: 30_000,
});

/**
 * Pure resolver used by runtime caching and PMA previews:
 * - Main SysAdmin always resolves to all 19 keys regardless of group/overrides.
 * - Secondary IT Admin with `groupKeys === null` starts with the Read-Only
 *   Monitoring baseline (5 view keys).
 * - Applies `GRANT` and `DENY` overrides on top, keeping catalog ordering.
 */
export function resolveSysAdminPermissions(
  groupKeys: readonly string[] | null,
  overrides: readonly SysAdminOverrideInput[],
  isRootSysAdmin = false
): string[] {
  if (isRootSysAdmin) {
    return [...ALL_SYSADMIN_PERMISSION_KEYS];
  }

  const base = groupKeys ?? READ_ONLY_BASELINE_KEYS;
  const held = new Set<string>();

  for (const key of base) {
    if (getSysAdminPermission(key)) {
      held.add(key);
    }
  }

  for (const ov of overrides) {
    if (!getSysAdminPermission(ov.permissionKey)) continue;
    if (ov.effect === "GRANT") {
      held.add(ov.permissionKey);
    } else if (ov.effect === "DENY") {
      held.delete(ov.permissionKey);
    }
  }

  return SYSADMIN_PERMISSIONS.filter((p) => held.has(p.key)).map((p) => p.key);
}

export async function getEffectiveSysAdminPermissions(
  sysAdminId: number
): Promise<EffectiveSysAdminPermissions | null> {
  if (!Number.isInteger(sysAdminId) || sysAdminId <= 0) return null;

  const hit = cache.get(sysAdminId);
  if (hit) return hit;

  const [row, mainId] = await Promise.all([
    prisma.sysAdmin.findUnique({
      where: { id: sysAdminId },
      select: {
        id: true,
        status: true,
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

  if (!row || row.status !== "Active") return null;

  const isRoot = row.id === mainId;
  const groupKeys = row.accessGroup
    ? row.accessGroup.permissions.map((p) => p.permissionKey)
    : null;
  const permissions = resolveSysAdminPermissions(groupKeys, row.permissionOverrides, isRoot);

  const effective: EffectiveSysAdminPermissions = {
    sysAdminId: row.id,
    isMainSysAdmin: isRoot,
    groupId: isRoot ? null : (row.accessGroup?.id ?? null),
    groupName: isRoot ? null : (row.accessGroup?.name ?? null),
    baselineName: isRoot
      ? "Main SysAdmin (Full access)"
      : (row.accessGroup?.name ?? "Read-Only Monitoring (Default)"),
    permissions,
  };

  cache.set(sysAdminId, effective);
  return effective;
}

export function invalidateSysAdminPermissions(sysAdminId?: number): void {
  if (typeof sysAdminId === "number") {
    cache.delete(sysAdminId);
  } else {
    cache.clear();
  }
}

export function invalidateSysAdminGroupMembers(groupId: number): void {
  for (const [id, entry] of cache.entries()) {
    if (entry.groupId === groupId) {
      cache.delete(id);
    }
  }
}
