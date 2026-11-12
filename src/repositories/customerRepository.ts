import { prisma } from "../lib/prisma.js";
import { normalizeUsername, normalizeEmail, looksLikeEmail } from "../lib/identity.js";
import type { Prisma } from "@prisma/client";

// The photo's bytes stay out: every login, refresh and profile read loads this,
// and the photo itself (up to 740 KB of base64) is served by its own signed
// link, GET /api/customers/:id/photo (customerPhotoLink.ts).
const WITH_INFORMATION = {
  information: true,
  profilePhoto: { select: { id: true, mimeType: true, fileSize: true, fileName: true, updatedAt: true } },
} as const;

export interface CustomerCreateData {
  username: string;
  passwordHash?: string | null;
  googleId?: string | null;
  email: string;
  status?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  information: {
    firstName: string;
    middleName?: string;
    lastName: string;
    birthdate?: Date | null;
    phone?: string;
    phoneVerified?: boolean;
    phoneVerifiedAt?: Date | null;
    avatar?: string;
  };
}

export interface CustomerUpdateData {
  username?: string;
  email?: string;
  status?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  passwordHash?: string | null;
  googleId?: string | null;
  expoPushToken?: string | null;
  information?: {
    firstName?: string;
    middleName?: string | null;
    lastName?: string;
    birthdate?: Date | null;
    phone?: string | null;
    phoneVerified?: boolean;
    phoneVerifiedAt?: Date | null;
    avatar?: string | null;
  };
}

export const customerRepository = {
  findByGoogleId(googleId: string) {
    return prisma.customerAccount.findUnique({ where: { googleId }, include: WITH_INFORMATION });
  },

  findByEmail(email: string) {
    return prisma.customerAccount.findFirst({
      where: { email: normalizeEmail(email) },
      include: WITH_INFORMATION,
    });
  },

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

  findByPhone(phone: string) {
    const digits = phone.replace(/\D/g, "");
    const clean = digits.length >= 10 ? digits.slice(-10) : digits;
    if (!clean) return Promise.resolve(null);
    return prisma.customerAccount.findFirst({
      where: {
        information: {
          OR: [
            { phone: clean },
            { phone: `+63${clean}` },
            { phone: `0${clean}` },
            { phone: `63${clean}` },
          ],
        },
      },
      include: WITH_INFORMATION,
    });
  },

  // Every account holding this number, in any of the four spellings findByPhone
  // matches. customer_information.phone is not unique, so "the" account for a
  // number is a question with more than one answer; findByPhone's findFirst
  // picked whichever row MariaDB returned first. verifiedOnly limits it to
  // accounts that proved the number by SMS, which is the only claim worth
  // honouring for a password reset or a duplicate check.
  findAllByPhone(phone: string, opts: { verifiedOnly?: boolean } = {}) {
    const digits = phone.replace(/\D/g, "");
    const clean = digits.length >= 10 ? digits.slice(-10) : digits;
    if (!clean) return Promise.resolve([]);
    return prisma.customerAccount.findMany({
      where: {
        information: {
          OR: [
            { phone: clean },
            { phone: `+63${clean}` },
            { phone: `0${clean}` },
            { phone: `63${clean}` },
          ],
          ...(opts.verifiedOnly ? { phoneVerified: true } : {}),
        },
      },
      include: WITH_INFORMATION,
    });
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
