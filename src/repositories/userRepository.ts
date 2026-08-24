import { prisma } from "../lib/prisma.js";
import { normalizeUsername, normalizeEmail, looksLikeEmail } from "../lib/identity.js";
import type { Prisma } from "@prisma/client";

export const userRepository = {
  // Sign-in accepts either a username or an email address. The two namespaces
  // cannot collide: USERNAME_PATTERN (userValidators.ts) excludes "@", so an
  // identifier containing "@" is unambiguously an email. Branching on that is
  // deterministic, unlike an OR + findFirst which would pick an arbitrary row
  // if the invariant ever broke.
  //
  // Usernames are deliberately NOT lower-cased: they are stored with real mixed
  // case (Owner12, testrider1) and the MySQL collation is already
  // case-insensitive, so folding here would be a no-op today and a bug on a
  // future case-sensitive collation. Emails are canonicalised to lower case on
  // write, so the lookup matches.
  findByIdentifier(identifier: string) {
    const value = identifier.trim();
    // Guard the empty string explicitly — otherwise it would match the blank
    // email that legacy rows are allowed to carry.
    if (!value) return Promise.resolve(null);
    return looksLikeEmail(value)
      ? prisma.user.findFirst({ where: { email: normalizeEmail(value) } })
      : prisma.user.findUnique({ where: { username: normalizeUsername(value) } });
  },

  findById(id: number) {
    return prisma.user.findUnique({ where: { id } });
  },

  markEmailVerified(id: number) {
    return prisma.user.update({
      where: { id },
      data: { emailVerified: true, emailVerifiedAt: new Date() },
    });
  },

  // The bootstrap admin supplying a real identity for the first time. Saving a
  // new address necessarily un-verifies the account: the OTP that follows is
  // what proves this new mailbox is reachable.
  completeBootstrapProfile(
    id: number,
    data: { firstName: string; middleName: string; lastName: string; email: string }
  ) {
    return prisma.user.update({
      where: { id },
      data: {
        ...data,
        email: data.email.toLowerCase(),
        profileCompleted: true,
        emailVerified: false,
        emailVerifiedAt: null,
      },
    });
  },

  // Normalised for the same reason as the customer equivalent: the duplicate
  // check must ask in the canonical form, or "Jayvee" registers alongside
  // "jayvee" and both resolve to one another at sign-in.
  findByUsernameOrEmail(username: string, email: string) {
    return prisma.user.findFirst({
      where: {
        OR: [{ username: normalizeUsername(username) }, { email: normalizeEmail(email) }],
      },
    });
  },

  findMany() {
    return prisma.user.findMany();
  },

  // Full roster regardless of status — backs the dispatcher/owner fleet-monitoring
  // views, filtered further in userService for the online-only "Assign Rider" picker.
  findAllRiders() {
    return prisma.user.findMany({
      where: { role: "RIDER" },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatar: true,
        status: true,
      },
    });
  },

  create(data: Prisma.UserCreateInput) {
    return prisma.user.create({ data });
  },

  update(id: number, data: Prisma.UserUpdateInput) {
    return prisma.user.update({ where: { id }, data });
  },

  // Conditional write: only applies if `version` still matches what the client
  // last read. A resulting count of 0 means someone else changed this user first.
  updateWithVersion(id: number, expectedVersion: number, data: Prisma.UserUpdateManyMutationInput) {
    return prisma.user.updateMany({
      where: { id, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
  },

  updatePushToken(id: number, expoPushToken: string) {
    return prisma.user.update({ where: { id }, data: { expoPushToken } });
  },
};
