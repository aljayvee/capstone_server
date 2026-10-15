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
import type { ResetAudience } from "../services/staffPasswordResetService.js";
import { getClientIp, getDeviceHint, getUserAgent } from "../lib/requestContext.js";
import { notifySessionRevoked } from "../lib/socket.js";

// Staff "forgot password", for the web portal (OWNER, DISPATCHER) and the rider
// app (RIDER). The rules live in staffPasswordResetService; these handlers only
// parse, pass the caller's IP, user agent and handset down for the audit trail
// and the emails, and shape the response.
//
// Every refusal is a 4xx other than 401 on purpose: both clients' interceptors
// treat a 401 as "refresh the session and retry", and someone on this screen
// has no session to refresh.

const resetContext = (req: Request) => ({
  ipAddress: getClientIp(req),
  userAgent: getUserAgent(req),
  deviceHint: getDeviceHint(req),
});

function handlersFor(audience: ResetAudience) {
  return {
    find: asyncHandler(async (req, res) => {
      const { identifier, website } = parseOrThrow(staffResetFindSchema, req.body);
      const account = await staffPasswordResetService.findAccount(identifier, website, resetContext(req), audience);
      res.status(200).json(account);
    }),

    sendCode: asyncHandler(async (req, res) => {
      const { resetSessionToken, channel } = parseOrThrow(staffResetSendCodeSchema, req.body);
      const result = await staffPasswordResetService.sendCode(resetSessionToken, channel, resetContext(req), audience);
      res.status(200).json(result);
    }),

    verify: asyncHandler(async (req, res) => {
      const { resetSessionToken, code, firebaseIdToken } = parseOrThrow(staffResetVerifySchema, req.body);
      const result = await staffPasswordResetService.verify(
        resetSessionToken,
        { code, firebaseIdToken },
        resetContext(req),
        audience
      );
      res.status(200).json(result);
    }),

    complete: asyncHandler(async (req, res) => {
      const { resetToken, password } = parseOrThrow(staffResetCompleteSchema, req.body);
      const { userId } = await staffPasswordResetService.complete(resetToken, password, resetContext(req), audience);
      // Any tab or handset still signed in on the old password signs out now
      // rather than at its next refresh.
      notifySessionRevoked(userId, { reason: "PASSWORD_RESET" });
      res.status(200).json({ message: "Your password has been reset. Sign in with your new password." });
    }),
  };
}

const web = handlersFor("WEB_PORTAL");
export const findStaffAccount = web.find;
export const sendStaffResetCode = web.sendCode;
export const verifyStaffReset = web.verify;
export const completeStaffReset = web.complete;

const rider = handlersFor("RIDER_APP");
export const findRiderAccount = rider.find;
export const sendRiderResetCode = rider.sendCode;
export const verifyRiderReset = rider.verify;
export const completeRiderReset = rider.complete;
