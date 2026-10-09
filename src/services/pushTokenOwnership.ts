import { prisma } from "../lib/prisma.js";

/**
 * Which account a phone's push token belongs to: the last one that signed in
 * on that phone, and nobody once it signs out.
 *
 * A push token names a device, not a person. It used to be written onto the
 * account that registered it and never taken off any other, and logging out
 * left it in place. Sign in as customer A, sign out, sign in as customer B on
 * the same phone, and the token sat on both rows, so A's delivery alerts kept
 * arriving on a phone now signed in as B (2026-10-07).
 *
 * Customers and staff are separate tables numbered separately, so the owner is
 * named by both kind and id. The token is removed from every row of both tables
 * except the owner's, because one phone can hold the customer app and the
 * rider app, and the rider app's token is not the customer app's anyway, but a
 * reinstall or a shared device must never leave a stale copy behind.
 */
export type PushTokenOwner = { kind: "customer" | "user"; id: number };

export function pushTokenOwnerFor(role: string | undefined, id: number): PushTokenOwner {
  return { kind: String(role || "").toUpperCase() === "CUSTOMER" ? "customer" : "user", id };
}

/** The token now reaches `owner` and only `owner`. */
export async function assignPushToken(owner: PushTokenOwner, token: string): Promise<void> {
  await prisma.$transaction([
    prisma.customerAccount.updateMany({
      where: { expoPushToken: token, ...(owner.kind === "customer" ? { NOT: { id: owner.id } } : {}) },
      data: { expoPushToken: null },
    }),
    prisma.user.updateMany({
      where: { expoPushToken: token, ...(owner.kind === "user" ? { NOT: { id: owner.id } } : {}) },
      data: { expoPushToken: null },
    }),
    owner.kind === "customer"
      ? prisma.customerAccount.update({ where: { id: owner.id }, data: { expoPushToken: token } })
      : prisma.user.update({ where: { id: owner.id }, data: { expoPushToken: token } }),
  ]);
}

/**
 * Signed out: this account's alerts stop reaching the phone it signed out of.
 *
 * The column holds one token per account, the latest phone's, so signing out
 * of an older phone also quiets the newer one until that app next opens, when
 * it registers again. Quiet for a moment beats alerts on a stranger's phone.
 */
export async function releasePushToken(owner: PushTokenOwner): Promise<void> {
  if (owner.kind === "customer") {
    await prisma.customerAccount.updateMany({ where: { id: owner.id }, data: { expoPushToken: null } });
  } else {
    await prisma.user.updateMany({ where: { id: owner.id }, data: { expoPushToken: null } });
  }
}
