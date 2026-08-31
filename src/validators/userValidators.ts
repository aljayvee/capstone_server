import { z } from "zod";

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PERSON_NAME_PATTERN = /^[A-Za-zÑñ.\-'\s]+$/;
const ROLES = ["OWNER", "DISPATCHER", "RIDER", "owner", "dispatcher", "rider"] as const;

// Roles whose re-assignment costs the acting admin their own password. Kept
// here next to the schema that carries `adminPassword`; enforced in
// userService.updateUser().
export const ROLE_CHANGE_REAUTH_ROLES = ["DISPATCHER", "RIDER"];

// Deliberately an allow-list rather than a shape check: a typo'd domain
// (gmial.com, outlok.com) satisfies any regex but can never receive a password
// reset, so the account is unrecoverable. Mirrored in the web dashboard at
// src/utils/userValidation.ts — extend both together.
export const ALLOWED_EMAIL_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "yahoo.com.ph",
  "outlook.com",
  "outlook.ph",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "zoho.com",
  "gmx.com",
  "mail.com",
  "yandex.com",
];

function hasAllowedDomain(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && ALLOWED_EMAIL_DOMAINS.includes(domain);
}

// Exported so the sign-in profile-setup step enforces literally these rules
// rather than a second copy that drifts from them.
export const strictEmail = z
  .string()
  .trim()
  .min(1, "Email address is required.")
  .regex(EMAIL_PATTERN, "Enter a complete email address (e.g. juandelacruz@gmail.com).")
  .refine(hasAllowedDomain, "That email provider is not accepted. Use @gmail.com, @outlook.com, @yahoo.com, or another major mail service.");

// Philippine mobile numbers only: exactly 11 digits beginning 09. Digits and
// nothing else — a phone that cannot be dialled is worse than a blank one
// because dispatch assumes it works.
const strictPhone = z
  .string()
  .trim()
  .regex(/^\d+$/, "Phone number may contain digits only — no letters, spaces, or symbols.")
  .regex(/^09/, "Philippine mobile numbers must start with 09 (e.g. 09171234567).")
  .length(11, "Phone number must be exactly 11 digits.");

// 8-character minimum, and whitespace is rejected outright — a password of
// spaces satisfied the old length rule while being effectively blank.
const strongPassword = z
  .string()
  .min(8, "Password must be at least 8 characters long.")
  .refine((v) => !/\s/.test(v), "Password cannot contain spaces or tabs.")
  .refine((v) => /[A-Za-z]/.test(v), "Password must contain at least one letter.")
  .refine((v) => /\d/.test(v), "Password must contain at least one number.");

export const personName = (label: string) =>
  z
    .string()
    .trim()
    .min(2, `${label} must be at least 2 characters long.`)
    .regex(PERSON_NAME_PATTERN, `${label} may only contain letters, spaces, hyphens, apostrophes, and dots.`);

export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username is required and must be at least 3 characters long.")
    .regex(USERNAME_PATTERN, "Username can only contain letters, numbers, underscores, dots, and dashes."),
  password: strongPassword,
  firstName: personName("First Name"),
  middleName: z
    .union([personName("Middle Name"), z.literal("")])
    .optional()
    .default(""),
  lastName: personName("Last Name"),
  email: strictEmail,
  phone: strictPhone,
  // No longer optional: an account created without a deliberate role silently
  // became a Rider. The dashboard now starts the picker at "Not Assigned" and
  // this is the server-side half of that rule.
  role: z.enum(ROLES, { message: "A role must be assigned — an account cannot be saved as Not Assigned." }),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters long.")
    .regex(USERNAME_PATTERN, "Username can only contain letters, numbers, underscores, dots, and dashes.")
    .optional(),
  password: z.union([strongPassword, z.literal("")]).optional(),
  firstName: personName("First Name").optional(),
  middleName: z.union([personName("Middle Name"), z.literal("")]).optional(),
  lastName: personName("Last Name").optional(),
  email: strictEmail.optional(),
  phone: strictPhone.optional(),
  status: z.enum(["Active", "Inactive", "active", "inactive"]).optional(),
  role: z.enum(ROLES).optional(),
  // The acting admin's OWN password, re-entered to authorise a Dispatcher or
  // Rider role change. Ignored for every other kind of edit.
  adminPassword: z.string().optional(),
  version: z.number().int().positive("A version number is required to save changes."),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// The rider app's Edit Account form and the dashboard's own profile edit both
// land here. It used to accept any trimmed string for email and phone, so this
// was the one path by which an account could acquire an address that bounces or
// a number that cannot be dialled — the exact things createUserSchema exists to
// prevent. Same rules, same messages, one definition.
export const profileUpdateSchema = z.object({
  firstName: personName("First Name").optional(),
  lastName: personName("Last Name").optional(),
  email: strictEmail.optional(),
  phone: strictPhone.optional(),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

// Self-service password change. Deliberately separate from updateUserSchema's
// optional `password` field, which is the Owner resetting someone else's
// credential — this one requires proving you already know the current one.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required."),
  newPassword: strongPassword,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
