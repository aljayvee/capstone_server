import { prisma } from "./prisma.js";

/**
 * The Main Owner: the first Admin (OWNER) account ever created, by the lowest
 * users.id with role OWNER. On production that is id 1 (read 2026-11-04).
 *
 * Only this account manages access groups and Admin accounts (the owner's
 * instruction of 2026-11-04). It always holds every Admin permission, and no
 * group or override applies to it, so there is always exactly one account that
 * can undo any access mistake.
 *
 * Computed rather than stored, so nothing has to be seeded on any database.
 * It cannot drift in practice because the guards in userService and
 * accessService refuse every edit that would move it: demoting or deactivating
 * the Main Owner, and promoting an account with a lower id to OWNER.
 */

const TTL_MS = 5 * 60 * 1000;
let cached: { id: number | null; at: number } | null = null;

export async function getMainOwnerId(): Promise<number | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.id;
  const row = await prisma.user.findFirst({
    where: { role: "OWNER" },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  cached = { id: row?.id ?? null, at: Date.now() };
  return cached.id;
}

export async function isMainOwner(userId: number | null | undefined, role?: string | null): Promise<boolean> {
  if (userId === null || userId === undefined) return false;
  if (role !== undefined && role !== null && String(role).toUpperCase() !== "OWNER") return false;
  return (await getMainOwnerId()) === userId;
}

/** After a role change that could move it (tests, and the promotion guard). */
export function invalidateMainOwner(): void {
  cached = null;
}
