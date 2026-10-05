import { z } from "zod";
import { personName, strictEmail } from "./userValidators.js";

const nonEmptyTrimmed = (label: string) =>
  z.string().trim().min(1, `${label} must be a non-empty string`);

// Common forbidden dictionary substrings for administrative accounts
const FORBIDDEN_SUBSTRINGS = [
  "password",
  "admin",
  "sysadmin",
  "123456",
  "qwerty",
  "sugoexpress",
  "tacurong",
];

/**
 * Enterprise Password Complexity Policy for System Administrators:
 * - Minimum 12 characters, maximum 128 characters
 * - At least one uppercase letter (A-Z)
 * - At least one lowercase letter (a-z)
 * - At least one numeric digit (0-9)
 * - At least one special symbol (!@#$%^&*()_+-=[]{}|;:,.<>?)
 * - Rejects trivial common dictionary patterns
 */
export const sysAdminPasswordPolicy = z
  .string()
  .min(12, "Administrator password must be at least 12 characters long.")
  .max(128, "Password must not exceed 128 characters.")
  .refine((val) => /[A-Z]/.test(val), {
    message: "Password must contain at least one uppercase letter.",
  })
  .refine((val) => /[a-z]/.test(val), {
    message: "Password must contain at least one lowercase letter.",
  })
  .refine((val) => /[0-9]/.test(val), {
    message: "Password must contain at least one numeric digit.",
  })
  .refine((val) => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(val), {
    message: "Password must contain at least one special symbol.",
  })
  .refine(
    (val) => {
      const lower = val.toLowerCase();
      return !FORBIDDEN_SUBSTRINGS.some((sub) => lower.includes(sub));
    },
    {
      message: "Password contains a common, easily guessable administrative word or sequence.",
    }
  );

/**
 * 1. SysAdmin Login Payload
 */
export const sysAdminLoginSchema = z
  .object({
    username: nonEmptyTrimmed("Username").max(50, "Username too long."),
    password: z.string().min(1, "Password is required.").max(128, "Password too long."),
  })
  .strict();
export type SysAdminLoginInput = z.infer<typeof sysAdminLoginSchema>;

/**
 * 2. Adaptive 2FA Verification Payload
 */
export const sysAdmin2FaVerifySchema = z
  .object({
    challengeToken: nonEmptyTrimmed("Challenge session token"),
    code: z.string().trim().regex(/^\d{6}$/, "2FA verification code must be exactly 6 digits."),
    trustDevice: z.boolean().optional().default(false),
    deviceFingerprint: z.string().trim().max(128).optional(),
  })
  .strict();
export type SysAdmin2FaVerifyInput = z.infer<typeof sysAdmin2FaVerifySchema>;

/**
 * 3. Adaptive 2FA Resend Payload
 */
export const sysAdmin2FaResendSchema = z
  .object({
    challengeToken: nonEmptyTrimmed("Challenge session token"),
  })
  .strict();
export type SysAdmin2FaResendInput = z.infer<typeof sysAdmin2FaResendSchema>;

/**
 * 4. Account Emergency Unlock Payload
 */
export const sysAdminUnlockAccountSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{64}$/, "Unlock token must be a valid 64-character hexadecimal string."),
  })
  .strict();
export type SysAdminUnlockAccountInput = z.infer<typeof sysAdminUnlockAccountSchema>;

/**
 * 5. Password Update Payload with Step-Up Re-Authentication
 */
export const sysAdminChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current administrator password is required."),
    newPassword: sysAdminPasswordPolicy,
    confirmNewPassword: z.string().min(1, "Password confirmation is required."),
  })
  .strict()
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "New password and confirmation password do not match.",
    path: ["confirmNewPassword"],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "New password must be different from your current password.",
    path: ["newPassword"],
  });
export type SysAdminChangePasswordInput = z.infer<typeof sysAdminChangePasswordSchema>;

/**
 * 6. Step-Up Re-Authentication Payload
 */
export const stepUpPasswordSchema = z
  .object({
    stepUpPassword: z.string().min(1, "Current administrator password is required."),
  })
  .strict();
export type StepUpPasswordInput = z.infer<typeof stepUpPasswordSchema>;

/**
 * 7. IT Admin Creation Payload with Step-Up Verification
 */
export const createItAdminSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3, "Username must be at least 3 characters.")
      .max(50, "Username must not exceed 50 characters.")
      .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain alphanumeric characters and underscores."),
    email: strictEmail,
    firstName: personName("First Name"),
    lastName: personName("Last Name"),
    initialPassword: sysAdminPasswordPolicy,
    stepUpPassword: z.string().min(1, "Step-up verification password is required."),
  })
  .strict();
export type CreateItAdminInput = z.infer<typeof createItAdminSchema>;

/**
 * 8. Two-Factor Authentication Enforcement Toggle
 */
export const sysAdminToggle2FaSchema = z
  .object({
    enforceTwoFactor: z.boolean(),
    stepUpPassword: z.string().min(1, "Administrator password is required to change 2FA policy."),
  })
  .strict();
export type SysAdminToggle2FaInput = z.infer<typeof sysAdminToggle2FaSchema>;
