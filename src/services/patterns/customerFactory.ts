import bcrypt from "bcryptjs";
import { normalizeUsername, normalizeEmail } from "../../lib/identity.js";
import type { CustomerCreateData } from "../../repositories/customerRepository.js";
import { currentPublicOrigin } from "../../lib/publicOrigin.js";
import { customerPhotoUrl } from "../../lib/customerPhotoLink.js";

export interface CustomerFactoryInput {
  username: string;
  password: string;
  email: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  birthdate?: string | Date | null;
  phone?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  phoneVerifiedAt?: Date | null;
}

// Mirrors userFactory.ts's hash-password + build-object logic, but targets the
// two-table CustomerAccount + CustomerInformation shape instead of the flat User row.
export async function buildCustomerAccountCreateData(input: CustomerFactoryInput): Promise<CustomerCreateData> {
  const passwordHash = await bcrypt.hash(input.password.trim(), 10);
  let parsedBirthdate: Date | null = null;
  if (input.birthdate) {
    parsedBirthdate = typeof input.birthdate === "string" ? new Date(input.birthdate) : input.birthdate;
    if (isNaN(parsedBirthdate.getTime())) {
      parsedBirthdate = null;
    }
  }

  const isPhoneVerified = input.phoneVerified ?? false;
  const verifiedAt = isPhoneVerified ? (input.phoneVerifiedAt || new Date()) : null;

  return {
    // Stored in canonical form so the unique index, the duplicate check and
    // the sign-in lookup are all comparing the same string. Previously only
    // the email was canonicalised and the username leaned on collation.
    username: normalizeUsername(input.username),
    passwordHash,
    email: normalizeEmail(input.email),
    emailVerified: input.emailVerified ?? false,
    phoneVerified: isPhoneVerified,
    information: {
      firstName: input.firstName.trim(),
      middleName: input.middleName ? input.middleName.trim() : "",
      lastName: input.lastName.trim(),
      birthdate: parsedBirthdate,
      phone: input.phone ? input.phone.trim() : "",
      phoneVerified: isPhoneVerified,
      phoneVerifiedAt: verifiedAt,
    },
  };
}

type CustomerWithInformation = {
  id: number;
  username: string;
  email: string;
  status: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  passwordHash?: string | null;
  googleId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  information: {
    firstName: string;
    middleName: string | null;
    lastName: string;
    birthdate?: Date | null;
    phone: string;
    phoneVerified?: boolean;
    phoneVerifiedAt?: Date | null;
    avatar: string | null;
    updatedAt?: Date;
  } | null;
  // customerRepository leaves photoData out (the photo is served by its own
  // link); other callers may still pass it.
  profilePhoto?: {
    photoData?: string;
    mimeType: string;
    fileSize: number;
    fileName?: string | null;
    updatedAt?: Date;
  } | null;
};

/**
 * The customer's photo as the app should load it. With a request in scope, a
 * signed link (GET /api/customers/:id/photo) instead of the photo itself, so
 * profile, login and refresh responses stay a few hundred bytes on a slow
 * connection. Google photo addresses pass through. Outside a request there is
 * no origin to link to, so the stored photo goes inline as it always did.
 */
function customerAvatar(customer: CustomerWithInformation): string | null {
  const { id, information, profilePhoto } = customer;
  const origin = currentPublicOrigin();
  const legacyInline = information?.avatar?.startsWith("data:") ? information : null;

  if (origin && profilePhoto?.updatedAt) return customerPhotoUrl(origin, id, profilePhoto.updatedAt.getTime());
  if (profilePhoto?.photoData) return profilePhoto.photoData;
  if (origin && legacyInline?.updatedAt) return customerPhotoUrl(origin, id, legacyInline.updatedAt.getTime());
  return information?.avatar ?? null;
}

// Collapses the nested CustomerAccount+CustomerInformation Prisma result into the flat
// shape (firstName/lastName/phone at the top level) that callers already expect —
// mirrors the flat `User` row shape so authService/customerService don't need two
// different response contracts for staff vs. customer accounts.
export function flattenCustomerAccount<T extends CustomerWithInformation>(customer: T) {
  const { information, profilePhoto, passwordHash, ...rest } = customer;
  return {
    ...rest,
    // How the account was created, for the app's Home reminders: a Google
    // sign-up has no password (authService creates it with passwordHash null),
    // while a manual account keeps its password even after Google is linked to
    // it, so googleId alone cannot tell the two apart. The hash itself never
    // leaves this function.
    signUpMethod: (passwordHash ? "password" : "google") as "password" | "google",
    firstName: information?.firstName ?? "",
    middleName: information?.middleName ?? "",
    lastName: information?.lastName ?? "",
    birthdate: information?.birthdate ? information.birthdate.toISOString().split("T")[0] : null,
    phone: information?.phone ?? "",
    phoneVerified: (customer as any).phoneVerified || information?.phoneVerified || false,
    avatar: customerAvatar(customer),
  };
}
