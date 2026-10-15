import type { Request } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  staffResetFindSchema,
  staffResetSendCodeSchema,
  staffResetVerifySchema,
  staffResetCompleteSchema,
} from "../validators/authValidators.js";
import * as staffPasswordResetService from "../services/staffPasswordResetService.js";
import { getClientIp, getUserAgent } from "../lib/requestContext.js";
import { notifySessionRevoked } from "../lib/socket.js";

// Staff web-portal "forgot password". The rules live in
// staffPasswordResetService; these handlers only parse, pass the caller's IP and
// user agent down for the audit trail, and shape the response.
//
// Every refusal is a 4xx other than 401 on purpose: the portal's axios
// interceptor treats a 401 as "refresh the session and retry", and someone on
// this screen has no session to refresh.

const resetContext = (req: Request) => ({
  ipAddress: getClientIp(req),
  userAgent: getUserAgent(req),
});

export const findStaffAccount = asyncHandler(async (req, res) => {
  const { identifier, website } = parseOrThrow(staffResetFindSchema, req.body);
  const account = await staffPasswordResetService.findAccount(identifier, website, resetContext(req));
  res.status(200).json(account);
});

export const sendStaffResetCode = asyncHandler(async (req, res) => {
  const { resetSessionToken, channel } = parseOrThrow(staffResetSendCodeSchema, req.body);
  const result = await staffPasswordResetService.sendCode(resetSessionToken, channel, resetContext(req));
  res.status(200).json(result);
});

export const verifyStaffReset = asyncHandler(async (req, res) => {
  const { resetSessionToken, code, firebaseIdToken } = parseOrThrow(staffResetVerifySchema, req.body);
  const result = await staffPasswordResetService.verify(
    resetSessionToken,
    { code, firebaseIdToken },
    resetContext(req)
  );
  res.status(200).json(result);
});

export const completeStaffReset = asyncHandler(async (req, res) => {
  const { resetToken, password } = parseOrThrow(staffResetCompleteSchema, req.body);
  const { userId } = await staffPasswordResetService.complete(resetToken, password, resetContext(req));
  // Any portal tab still open on the old password signs out now rather than at
  // its next refresh.
  notifySessionRevoked(userId, { reason: "PASSWORD_RESET" });
  res.status(200).json({ message: "Your password has been reset. Sign in with your new password." });
});
