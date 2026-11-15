import { prisma } from "./prisma.js";

/**
 * The Main SysAdmin is the root IT Administrator — the lowest id in
 * tbl_sys_admin (seeded as the initial root IT Admin). Like Main Owner, it is
 * derived rather than stored in a mutable flag so another account cannot claim
 * root status or revoke the Main SysAdmin's privileges.
 */

const TTL_MS = 5 * 60 * 1000;

let cachedId: number | null | undefined;
let cachedAt = 0;

export async function getMainSysAdminId(): Promise<number | null> {
  if (cachedId !== undefined && Date.now() - cachedAt < TTL_MS) return cachedId;
  const row = await prisma.sysAdmin.findFirst({
    orderBy: { id: "asc" },
    select: { id: true },
  });
  cachedId = row?.id ?? null;
  cachedAt = Date.now();
  return cachedId;
}

export async function isMainSysAdmin(
  adminId: number | undefined,
  role: string | undefined
): Promise<boolean> {
  if (!adminId || String(role ?? "").toUpperCase() !== "SYSADMIN") return false;
  return adminId === (await getMainSysAdminId());
}

export function invalidateMainSysAdmin(): void {
  cachedId = undefined;
  cachedAt = 0;
}
