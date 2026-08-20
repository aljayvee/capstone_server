import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { customerProfileUpdateSchema } from "../validators/customerValidators.js";
import { customerPhotoUploadSchema } from "../validators/customerPhotoValidators.js";
import {
  verifyEmailSchema,
  resendVerificationSchema,
  sendRegistrationOtpSchema,
  verifyRegistrationOtpSchema,
  sendPhoneOtpSchema,
  verifyPhoneOtpSchema,
} from "../validators/emailVerificationValidators.js";
import * as customerService from "../services/customerService.js";
import * as emailVerificationService from "../services/emailVerificationService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";

function assertSelfOrOwner(req: AuthenticatedRequest, targetId: number) {
  const callerRole = String(req.user?.role || "").toUpperCase();
  if (callerRole !== "OWNER" && req.user?.id !== targetId) {
    throw new ServiceError(403, "Access denied: You can only access your own customer account.");
  }
}

export const getCustomerProfile = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const customerId = parseInt(req.params.id, 10);
  if (isNaN(customerId)) {
    throw new ServiceError(400, "Invalid customer ID");
  }
  assertSelfOrOwner(req, customerId);

  const customer = await customerService.getProfile(customerId);
  res.json(customer);
});

export const updateCustomerProfile = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const customerId = parseInt(req.params.id, 10);
  if (isNaN(customerId)) {
    throw new ServiceError(400, "Invalid customer ID");
  }
  assertSelfOrOwner(req, customerId);

  const input = parseOrThrow(customerProfileUpdateSchema, req.body);
  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || req.ip;
  const userAgent = req.headers["user-agent"] || undefined;
  const deviceId = (req.headers["x-device-id"] as string) || undefined;

  const customer = await customerService.updateProfile(customerId, input, {
    ipAddress,
    userAgent,
    deviceId,
  });
  res.status(200).json({ message: "Profile updated successfully", user: customer });
});

export const uploadCustomerPhoto = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const customerId = parseInt(req.params.id, 10);
  if (isNaN(customerId)) {
    throw new ServiceError(400, "Invalid customer ID");
  }
  assertSelfOrOwner(req, customerId);

  const input = parseOrThrow(customerPhotoUploadSchema, req.body);
  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || req.ip;
  const userAgent = req.headers["user-agent"] || undefined;
  const deviceId = (req.headers["x-device-id"] as string) || undefined;

  const result = await customerService.uploadCustomerPhoto(customerId, input, {
    ipAddress,
    userAgent,
    deviceId,
  });
  res.status(200).json(result);
});

export const deleteCustomerPhoto = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const customerId = parseInt(req.params.id, 10);
  if (isNaN(customerId)) {
    throw new ServiceError(400, "Invalid customer ID");
  }
  assertSelfOrOwner(req, customerId);

  const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || req.ip;
  const userAgent = req.headers["user-agent"] || undefined;
  const deviceId = (req.headers["x-device-id"] as string) || undefined;

  const result = await customerService.deleteCustomerPhoto(customerId, {
    ipAddress,
    userAgent,
    deviceId,
  });
  res.status(200).json(result);
});

export const getCustomerModificationLogs = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const customerId = parseInt(req.params.id, 10);
  if (isNaN(customerId)) {
    throw new ServiceError(400, "Invalid customer ID");
  }
  assertSelfOrOwner(req, customerId);

  const logs = await customerService.listModificationLogs(customerId);
  res.json(logs);
});

export const getCustomerTransactions = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const customerId = parseInt(req.params.id, 10);
  if (isNaN(customerId)) {
    throw new ServiceError(400, "Invalid customer ID");
  }
  assertSelfOrOwner(req, customerId);

  const transactions = await customerService.listTransactions(customerId);
  res.json(transactions);
});

// Pre-registration OTP endpoints (unauthenticated)
export const sendRegistrationOtp = asyncHandler(async (req, res) => {
  const input = parseOrThrow(sendRegistrationOtpSchema, req.body);
  await emailVerificationService.sendRegistrationOtp(input.email);
  res.json({ success: true, message: "Verification code sent to email." });
});

export const verifyRegistrationOtp = asyncHandler(async (req, res) => {
  const input = parseOrThrow(verifyRegistrationOtpSchema, req.body);
  await emailVerificationService.verifyRegistrationOtp(input.email, input.code);
  res.json({ success: true, message: "Email verified successfully." });
});

export const sendRegistrationPhoneOtp = asyncHandler(async (req, res) => {
  const input = parseOrThrow(sendPhoneOtpSchema, req.body);
  await emailVerificationService.sendRegistrationPhoneOtp(input.phone);
  res.json({ success: true, message: "Verification code sent via SMS." });
});

export const verifyRegistrationPhoneOtp = asyncHandler(async (req, res) => {
  const input = parseOrThrow(verifyPhoneOtpSchema, req.body);
  await emailVerificationService.verifyRegistrationPhoneOtp(input.phone, input.code);
  res.json({ success: true, message: "Phone number verified successfully." });
});

// Deliberately unauthenticated — the customer has a JWT immediately after
// registration, but requiring it here would mean priming apiClient's token
// before the account is confirmed verified, purely to satisfy this one call.
// The 6-digit code (short-lived, attempt-capped) is the actual security
// boundary, not the auth header — see emailVerificationService.verifyCode.
export const verifyEmail = asyncHandler(async (req, res) => {
  const input = parseOrThrow(verifyEmailSchema, req.body);
  await emailVerificationService.verifyCode(input.customerId, input.code);
  res.json({ success: true, message: "Email verified successfully." });
});

export const resendVerificationEmail = asyncHandler(async (req, res) => {
  const input = parseOrThrow(resendVerificationSchema, req.body);
  await emailVerificationService.resendVerificationCode(input.customerId);
  res.json({ success: true, message: "Verification code resent." });
});
