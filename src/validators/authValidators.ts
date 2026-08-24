import { z } from "zod";
import { personName, strictEmail } from "./userValidators.js";

const nonEmptyTrimmed = (label: string) => z.string().trim().min(1, `${label} must be a non-empty string`);

// The wire key stays `username` even though the field now accepts an email too:
// the rider mobile app is a separate deploy that still posts {username, password},
// and renaming the key would break it. Only the label the user reads changes.
export const loginSchema = z.object({
  username: nonEmptyTrimmed("Username or email"),
  password: nonEmptyTrimmed("Password"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const challengeTokenSchema = z.object({
  challengeToken: nonEmptyTrimmed("Sign-in session"),
});
export type ChallengeTokenInput = z.infer<typeof challengeTokenSchema>;

// Reuses the exact schemas that guard user creation, so the bootstrap admin's
// first-run form is held to the same standard as the Add User modal.
export const completeLoginProfileSchema = z.object({
  challengeToken: nonEmptyTrimmed("Sign-in session"),
  firstName: personName("First Name"),
  middleName: z.union([personName("Middle Name"), z.literal("")]).optional().default(""),
  lastName: personName("Last Name"),
  email: strictEmail,
});
export type CompleteLoginProfileInput = z.infer<typeof completeLoginProfileSchema>;

export const verifyLoginOtpSchema = z.object({
  challengeToken: nonEmptyTrimmed("Sign-in session"),
  code: z.string().trim().regex(/^\d{6}$/, "Verification code must be 6 digits."),
});
export type VerifyLoginOtpInput = z.infer<typeof verifyLoginOtpSchema>;

// --- Customer password reset ---
//
// `website` is the honeypot. It is never rendered visibly by the app and no
// human can focus it, so any value at all marks the caller as a form-filling
// bot. It is `optional()` rather than required-empty on purpose: a legitimate
// old client that does not send the field must still work.
export const forgotPasswordSchema = z.object({
  identifier: nonEmptyTrimmed("Username or email"),
  website: z.string().optional(),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const verifyResetCodeSchema = z.object({
  identifier: nonEmptyTrimmed("Username or email"),
  code: z.string().trim().regex(/^\d{6}$/, "Verification code must be 6 digits."),
});
export type VerifyResetCodeInput = z.infer<typeof verifyResetCodeSchema>;

export const resetPasswordSchema = z.object({
  resetToken: nonEmptyTrimmed("Reset session"),
  // Edge-trimmed with the minimum measured after the trim, identical to
  // customerRegisterSchema — the two must agree or a password accepted here
  // would be rejected at registration, or worse, vice versa.
  password: z.string().trim().min(6, "Password must be at least 6 characters long"),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const customerRegisterSchema = z.object({
  username: nonEmptyTrimmed("Username"),
  // Trimmed at the edges only. Leading and trailing spaces are almost always a
  // stray keystroke or a paste artifact, and an invisible one at either end is
  // unreproducible on the next sign-in. Spaces INSIDE the password survive —
  // "open sesame please" is a passphrase, not a typo — and the 6-character
  // minimum is measured after the trim, on what actually gets hashed.
  password: z.string().trim().min(6, "Password must be at least 6 characters long"),
  email: nonEmptyTrimmed("Email"),
  firstName: nonEmptyTrimmed("First name"),
  middleName: z.string().trim().optional().default(""),
  lastName: nonEmptyTrimmed("Last name"),
  birthdate: z.string().trim().optional(),
  phone: z.string().trim().optional().default(""),
  emailVerified: z.boolean().optional(),
});
export type CustomerRegisterInput = z.infer<typeof customerRegisterSchema>;
