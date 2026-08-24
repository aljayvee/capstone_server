import { prisma } from "../lib/prisma.js";
import { normalizeUsername, normalizeEmail, looksLikeEmail } from "../lib/identity.js";
import type { Prisma } from "@prisma/client";

const WITH_INFORMATION = { information: true, profilePhoto: true } as const;

export interface CustomerCreateData {
  username: string;
  passwordHash: string;
  email: string;
  status?: string;
  emailVerified?: boolean;
  information: {
    firstName: string;
    middleName?: string;
    lastName: string;
    birthdate?: Date | null;
    phone?: string;
    avatar?: string;
  };
}

export interface CustomerUpdateData {
  username?: string;
  email?: string;
  status?: string;
  emailVerified?: boolean;
  passwordHash?: string;
  expoPushToken?: string | null;
  information?: {
    firstName?: string;
    middleName?: string | null;
    lastName?: string;
    birthdate?: Date | null;
    phone?: string | null;
    avatar?: string | null;
  };
}

export const customerRepository = {
  findByUsername(username: string) {
    return prisma.customerAccount.findUnique({ where: { username }, include: WITH_INFORMATION });
  },

  // Customer sign-in accepts either a username or an email address in the same
  // box. Mirrors userRepository.findByIdentifier so staff and customer logins
  // resolve an identifier by the same rule: an "@" means email (lowercased,
  // since addresses are stored lowercased at registration), anything else is a
  // username. The empty string is guarded explicitly rather than left to match
  // a blank email column.
  findByIdentifier(identifier: string) {
    const value = identifier.trim();
    if (!value) return Promise.resolve(null);
    // Both branches normalise now. The username branch used to pass the raw
    // string through and rely on the column's `_ci` collation to ignore case —
    // correct in practice, but a rule that lived nowhere in the code.
    return looksLikeEmail(value)
      ? prisma.customerAccount.findFirst({
          where: { email: normalizeEmail(value) },
          include: WITH_INFORMATION,
        })
      : prisma.customerAccount.findUnique({
          where: { username: normalizeUsername(value) },
          include: WITH_INFORMATION,
        });
  },

  findById(id: number) {
    return prisma.customerAccount.findUnique({ where: { id }, include: WITH_INFORMATION });
  },

  // The duplicate check behind registration. Normalised for the same reason the
  // lookup above is: "is this name taken?" must be asked in exactly the canonical
  // form the name would be stored in, or a case variant slips past and creates a
  // second account that can never be told apart from the first at sign-in.
  findByUsernameOrEmail(username: string, email: string) {
    return prisma.customerAccount.findFirst({
      where: {
        OR: [
          { username: normalizeUsername(username) },
          { email: normalizeEmail(email) },
        ],
      },
      include: WITH_INFORMATION,
    });
  },

  create(data: CustomerCreateData) {
    const { information, ...account } = data;
    return prisma.customerAccount.create({
      data: {
        ...account,
        information: { create: information },
      } as Prisma.CustomerAccountCreateInput,
      include: WITH_INFORMATION,
    });
  },

  update(id: number, data: CustomerUpdateData) {
    const { information, ...account } = data;
    return prisma.customerAccount.update({
      where: { id },
      data: {
        ...account,
        ...(information ? { information: { update: information } } : {}),
      } as Prisma.CustomerAccountUpdateInput,
      include: WITH_INFORMATION,
    });
  },

  markEmailVerified(id: number) {
    return prisma.customerAccount.update({ where: { id }, data: { emailVerified: true } });
  },
};
