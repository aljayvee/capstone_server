import { LRUCache } from "lru-cache";
import { prisma } from "./prisma.js";
import {
  FULL_ACCESS_GROUP_NAME,
  PERMISSIONS,
  getPermission,
  isPermissionKey,
  permissionKeysFor,
  scopeOfRole,
  type PermissionScope,
} from "./permissions.js";
import { getMainOwnerId } from "./mainOwner.js";
import { ServiceError } from "../services/ServiceError.js";

/**
 * What an Admin or Dispatcher account may do right now: its group's keys (or
 * every key of its role when it has no group), plus its GRANT overrides, minus
 * its DENY overrides.
 *
 * Cached per account for 30 s, like blocklistCache.ts, because every gated
 * request asks. Every write in accessService calls invalidatePermissions for
 * the accounts it touched, so a change lands on the very next request rather
 * than after the TTL. The TTL only bounds what a second API process would see,
 * and production runs one.
 *
 * Keyed on the bare user id, which is safe here and only here: customers are
 * numbered separately (customer-and-staff-ids-collide), but they never reach a
 * permission check, because scopeOfRole refuses every role but OWNER and
 * DISPATCHER first.
 */

export interface EffectivePermissions {
  scope: PermissionScope;
  isMainOwner: boolean;
  group: { id: number | null; name: string };
  /** In catalog order. */
  permissions: string[];
}

export interface PermissionOverrideRow {
  permissionKey: string;
  effect: "GRANT" | "DENY";
}

const TTL_MS = 30 * 1000;
const cache = new LRUCache<number, EffectivePermissions>({ max: 2000, ttl: TTL_MS });

/**
 * The arithmetic on its own, so tests can reach it without a database.
 * `groupKeys` null means Full access. Keys outside the catalog, or from the
 * other role's half of it, are ignored rather than trusted.
 */
export function resolvePermissions(
  scope: PermissionScope,
  groupKeys: string[] | null,
  overrides: PermissionOverrideRow[],
): string[] {
  const granted = new Set(
    groupKeys === null ? permissionKeysFor(scope) : groupKeys.filter((key) => isPermissionKey(key, scope)),
  );
  for (const override of overrides) {
    if (!isPermissionKey(override.permissionKey, scope)) continue;
    if (override.effect === "GRANT") granted.add(override.permissionKey);
    else granted.delete(override.permissionKey);
  }
  return PERMISSIONS.filter((p) => granted.has(p.key)).map((p) => p.key);
}

export async function getEffectivePermissions(
  userId: number,
  tokenRole: string,
): Promise<EffectivePermissions | null> {
  const tokenScope = scopeOfRole(tokenRole);
  if (!tokenScope) return null;

  const hit = cache.get(userId);
  if (hit && hit.scope === tokenScope) return hit;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      accessGroup: {
        select: { id: true, name: true, scope: true, permissions: { select: { permissionKey: true } } },
      },
      permissionOverrides: { select: { permissionKey: true, effect: true } },
    },
  });
  if (!user) return null;

  const scope = scopeOfRole(user.role);
  // The token still says the old role: a demotion within the access token's
  // lifetime. Its sessions are already being revoked; until then it gets nothing.
  if (scope !== tokenScope) {
    return { scope: tokenScope, isMainOwner: false, group: { id: null, name: FULL_ACCESS_GROUP_NAME }, permissions: [] };
  }

  const mainOwner = scope === "OWNER" && (await getMainOwnerId()) === user.id;
  const group = !mainOwner && user.accessGroup && user.accessGroup.scope === scope ? user.accessGroup : null;
  const effective: EffectivePermissions = {
    scope,
    isMainOwner: mainOwner,
    group: group ? { id: group.id, name: group.name } : { id: null, name: FULL_ACCESS_GROUP_NAME },
    permissions: mainOwner
      ? permissionKeysFor(scope)
      : resolvePermissions(
          scope,
          group ? group.permissions.map((p) => p.permissionKey) : null,
          user.permissionOverrides,
        ),
  };
  cache.set(userId, effective);
  return effective;
}

/** No ids clears everything, for a group edit whose member list is not to hand. */
export function invalidatePermissions(userIds?: number[]): void {
  if (!userIds) {
    cache.clear();
    return;
  }
  for (const id of userIds) cache.delete(id);
}

/**
 * For checks inside a handler, where the key depends on the request (a status
 * change that is a cancellation, a copilot tool). True for a caller outside
 * the key's role: those are gated by requireRole alone, exactly as before.
 */
export async function callerHasPermission(
  caller: { id: number; role: string } | undefined,
  key: string,
): Promise<boolean> {
  const permission = getPermission(key);
  if (!permission || !caller) return false;
  if (scopeOfRole(caller.role) !== permission.scope) return true;
  const effective = await getEffectivePermissions(caller.id, caller.role);
  return Boolean(effective?.permissions.includes(key));
}

/** callerHasPermission as a guard: a 403 with the same wording requirePermission uses. */
export async function assertCallerPermission(
  caller: { id: number; role: string } | undefined,
  key: string,
): Promise<void> {
  if (await callerHasPermission(caller, key)) return;
  throw new ServiceError(403, `Your access group does not include ${getPermission(key)?.label ?? key}.`, {
    code: "PERMISSION_DENIED",
    permission: key,
  });
}
