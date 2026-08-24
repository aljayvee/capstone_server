import { Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  loginSchema,
  customerRegisterSchema,
  forgotPasswordSchema,
  verifyResetCodeSchema,
  resetPasswordSchema,
  challengeTokenSchema,
  completeLoginProfileSchema,
  verifyLoginOtpSchema,
} from "../validators/authValidators.js";
import * as authService from "../services/authService.js";
import * as passwordResetService from "../services/passwordResetService.js";
import type { AuthResult, LoginOutcome } from "../services/authService.js";
import * as loginNotificationService from "../services/loginNotificationService.js";
import type { LoginChannel } from "../services/loginNotificationService.js";
import type { LoginChallenge } from "../services/loginChallengeService.js";
import { getClientIp, getDeviceHint, getDeviceId, getUserAgent } from "../lib/requestContext.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import * as riderPresenceService from "../services/riderPresenceService.js";
import * as sessionService from "../services/sessionService.js";

import { REFRESH_SESSION_TTL_MS } from "../config/env.js";

// Matches the refresh token's own lifetime. Previously pinned at 7 days while
// the token said 7 days too; both now follow JWT_REFRESH_EXPIRES_IN so the
// cookie can never outlive, or die before, the credential inside it.
const REFRESH_COOKIE_MAX_AGE = REFRESH_SESSION_TTL_MS;

// A dashboard served from a different origin than the API (e.g. the Vite dev
// server on :5173 against the tunnelled backend) is a cross-site context, and
// browsers refuse to send a SameSite=Lax cookie there — the refresh token never
// arrives and /auth/refresh always 401s. SameSite=None fixes that but is only
// accepted on a Secure cookie, so the two move together. Default stays Lax:
// same-origin deployments keep the stronger CSRF posture.
const CROSS_SITE_COOKIES = process.env.CROSS_SITE_COOKIES === "true";
const ACCESS_TOKEN_FALLBACK_MS = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_TOKEN_FALLBACK_MS = REFRESH_SESSION_TTL_MS;

// Facade: collapses the previously 3-4x duplicated "set refresh cookie + shape the
// login/register JSON response" block (one per auth endpoint) behind a single call.
function setRefreshCookie(res: Response, refreshToken: string) {
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: CROSS_SITE_COOKIES || process.env.NODE_ENV === "production",
    sameSite: CROSS_SITE_COOKIES ? "none" : "lax",
    maxAge: REFRESH_COOKIE_MAX_AGE,
  });
}

// Every path that hands out a token pair funnels through here — the four login
// and register endpoints below — which is what makes "no token exists without a
// session row behind it" true by construction rather than by remembering to
// call something at four call sites. The row is written before the response is
// sent: a client that receives a refresh token can always spend it.
async function respondWithAuth(
  req: Request,
  res: Response,
  status: number,
  message: string,
  result: AuthResult
) {
  await sessionService.createSession(
    result.sessionId,
    { id: result.user.id, role: result.role, subjectType: result.subjectType },
    result.refreshToken,
    {
      // Recorded now and compared on every rotation, so a refresh token that
      // turns up on a different handset than the one that signed in is caught.
      deviceId: getDeviceId(req),
      userAgent: getUserAgent(req),
      ipAddress: getClientIp(req),
    }
  );

  setRefreshCookie(res, result.refreshToken);
  res.status(status).json({
    message,
    user: result.user,
    token: result.accessToken,
    refreshToken: result.refreshToken,
    // Surfaced so a client can show "signed in on this device" and so support
    // can correlate a complaint with a row in user_sessions.
    sessionId: result.sessionId,
  });
}

function loginContext(req: Request, channel: LoginChannel) {
  return {
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req),
    deviceHint: getDeviceHint(req),
    channel,
  };
}

// A challenge is HTTP 200 with no token, not a 4xx. Two clients depend on that:
// the dashboard's axios interceptor would treat a 401 as "refresh and retry",
// and the rider app treats any !res.ok as fatal without reading the body.
// It also means entering the OTP flow does not burn a loginLimiter attempt,
// since that limiter is configured with skipSuccessfulRequests.
function respondWithChallenge(res: Response, challenge: LoginChallenge) {
  return res.status(200).json({
    message: challenge.step === "PROFILE_SETUP" ? "Profile setup required" : "Verification required",
    ...(challenge.step === "PROFILE_SETUP" ? { profileSetupRequired: true } : { otpRequired: true }),
    challengeToken: challenge.challengeToken,
    maskedEmail: challenge.maskedEmail,
    // Disclosed only after a correct password, so it is not an enumeration
    // vector — and it lets both clients turn away a wrong-surface role before
    // walking someone through an OTP they were never going to be able to use.
    role: challenge.role,
    expiresInSeconds: challenge.expiresInSeconds,
  });
}

function respondWithOutcome(req: Request, res: Response, outcome: LoginOutcome, channel: LoginChannel) {
  if (outcome.kind === "CHALLENGE") {
    return respondWithChallenge(res, outcome.challenge);
  }
  // Bare statement, never awaited: sendLoginAlert returns void and swallows its
  // own failures, so a mail problem cannot change this response.
  loginNotificationService.sendLoginAlert(outcome.user, loginContext(req, channel));
  return respondWithAuth(req, res, 200, "Login successful", outcome.result);
}

export const login = asyncHandler(async (req, res) => {
  const { username, password } = parseOrThrow(loginSchema, req.body);
  const outcome = await authService.loginGeneral(username, password);
  respondWithOutcome(req, res, outcome, "WEB_PORTAL");
});

export const riderLogin = asyncHandler(async (req, res) => {
  const { username, password } = parseOrThrow(loginSchema, req.body);
  const outcome = await authService.loginRider(username, password);
  respondWithOutcome(req, res, outcome, "RIDER_APP");
});

export const completeLoginProfile = asyncHandler(async (req, res) => {
  const input = parseOrThrow(completeLoginProfileSchema, req.body);
  const challenge = await authService.completeLoginProfile(input);
  respondWithChallenge(res, challenge);
});

export const verifyLoginOtp = asyncHandler(async (req, res) => {
  const { challengeToken, code } = parseOrThrow(verifyLoginOtpSchema, req.body);
  const { result, user, audience } = await authService.completeLoginOtp(challengeToken, code);
  loginNotificationService.sendLoginAlert(user, loginContext(req, audience));
  await respondWithAuth(req, res, 200, "Login successful", result);
});

export const resendLoginOtp = asyncHandler(async (req, res) => {
  const { challengeToken } = parseOrThrow(challengeTokenSchema, req.body);
  const challenge = await authService.resendLoginOtp(challengeToken);
  respondWithChallenge(res, challenge);
});

export const customerLogin = asyncHandler(async (req, res) => {
  const { username, password } = parseOrThrow(loginSchema, req.body);
  const result = await authService.loginCustomer(username, password);
  await respondWithAuth(req, res, 200, "Login successful", result);
});

export const customerRegister = asyncHandler(async (req, res) => {
  const input = parseOrThrow(customerRegisterSchema, req.body);
  const result = await authService.registerCustomer(input);
  await respondWithAuth(req, res, 201, "Customer registered successfully", result);
});

// --- Customer password reset (3 steps) ---
//
// Every handler passes the request's IP and user-agent down to the service,
// which writes them to password_reset_attempts. That is the whole point of the
// feature: without the IP on the row, a burst of misses is untraceable.
const resetContext = (req: Request) => ({
  ipAddress: getClientIp(req),
  userAgent: getUserAgent(req),
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { identifier, website } = parseOrThrow(forgotPasswordSchema, req.body);
  const result = await passwordResetService.requestReset(identifier, website, resetContext(req));
  // 200 on both the hit and the miss. A 404 here would re-introduce exactly the
  // account oracle the service goes out of its way to close.
  res.status(200).json(result);
});

export const verifyResetCode = asyncHandler(async (req, res) => {
  const { identifier, code } = parseOrThrow(verifyResetCodeSchema, req.body);
  const result = await passwordResetService.verifyResetCode(identifier, code, resetContext(req));
  res.status(200).json(result);
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { resetToken, password } = parseOrThrow(resetPasswordSchema, req.body);
  await passwordResetService.completeReset(resetToken, password, resetContext(req));
  res.status(200).json({ message: "Password updated. You can now sign in." });
});

export const refresh = asyncHandler(async (req, res) => {
  // Cookie first for the dashboard, body for the mobile apps — React Native's
  // networking has no usable cookie jar, so the phones carry the token
  // themselves and post it back here.
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ error: "Refresh token required." });
  }

  // Which half of that sentence applied decides whether the rotated token goes
  // back in the response body. A caller that proved it can hold the token —
  // by sending it — gets the replacement the same way. A browser that
  // authenticated purely by cookie does not: putting the value where page
  // JavaScript can read it would hand an XSS exactly what HttpOnly exists to
  // withhold, and the browser does not need it, since the Set-Cookie below
  // already rotated the copy it actually uses.
  const presentedInBody = Boolean(req.body?.refreshToken);

  const { accessToken, refreshToken: rotated, user } = await authService.refreshAccessToken(
    refreshToken,
    {
      deviceId: getDeviceId(req),
      userAgent: getUserAgent(req),
      ipAddress: getClientIp(req),
    }
  );

  // `rotated` is null when the grace window absorbed a concurrent refresh: the
  // client's stored token is still the live one, so overwriting the cookie or
  // echoing a replacement would be wrong.
  if (rotated) {
    setRefreshCookie(res, rotated);
  }

  res.status(200).json({
    token: accessToken,
    user,
    // Mobile clients persist this and discard the old one. Omitted rather than
    // sent as null so a client that blindly stores the field cannot wipe its
    // own working token.
    ...(rotated && presentedInBody ? { refreshToken: rotated } : {}),
  });
});

export const logout = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const authHeader = req.headers["authorization"];
  const accessToken = authHeader && authHeader.split(" ")[1];
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

  const tokensToRevoke: { token: string; expiresAt: Date }[] = [];
  if (accessToken) {
    tokensToRevoke.push(authService.buildRevocationEntry(accessToken, ACCESS_TOKEN_FALLBACK_MS));
  }
  if (refreshToken) {
    tokensToRevoke.push(authService.buildRevocationEntry(refreshToken, REFRESH_TOKEN_FALLBACK_MS));
  }

  await authService.revokeTokens(tokensToRevoke);

  // Close the session row as well as blocklisting the token. The blocklist
  // entry alone would let the row sit there looking live, and it is the row
  // that a future "sign out my other devices" screen acts on.
  if (refreshToken) {
    const sessionId = authService.sessionIdFromRefreshToken(refreshToken);
    if (sessionId) {
      await sessionService.revokeSession(sessionId, "USER_LOGOUT");
    }
  }

  if (req.user?.id) {
    void riderPresenceService.closeLoginSession(req.user.id);
  }

  res.clearCookie("refreshToken");
  res.status(200).json({ message: "Logged out successfully." });
});
