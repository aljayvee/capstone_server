import { z } from "zod";

export const verifyEmailSchema = z.object({
  customerId: z.coerce.number().int().positive("customerId is required."),
  code: z.string().trim().length(6, "Verification code must be 6 digits."),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const sendRegistrationOtpSchema = z.object({
  email: z.string().trim().email("Please provide a valid email address."),
});
export type SendRegistrationOtpInput = z.infer<typeof sendRegistrationOtpSchema>;

export const verifyRegistrationOtpSchema = z.object({
  email: z.string().trim().email("Please provide a valid email address."),
  code: z.string().trim().length(6, "Verification code must be 6 digits."),
});
export type VerifyRegistrationOtpInput = z.infer<typeof verifyRegistrationOtpSchema>;

export const sendPhoneOtpSchema = z.object({
  phone: z.string().trim().min(7, "Please provide a valid phone number."),
});
export type SendPhoneOtpInput = z.infer<typeof sendPhoneOtpSchema>;

export const verifyPhoneOtpSchema = z.object({
  phone: z.string().trim().min(7, "Please provide a valid phone number."),
  code: z.string().trim().length(6, "Verification code must be 6 digits."),
});
export type VerifyPhoneOtpInput = z.infer<typeof verifyPhoneOtpSchema>;

export const resendVerificationSchema = z.object({
  customerId: z.coerce.number().int().positive("customerId is required."),
});

export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
