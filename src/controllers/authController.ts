import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { loginSchema, customerRegisterSchema } from "../validators/authValidators.js";
import * as authService from "../services/authService.js";
import type { AuthResult } from "../services/authService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import * as riderPresenceService from "../services/riderPresenceService.js";

const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const ACCESS_TOKEN_FALLBACK_MS = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_TOKEN_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Facade: collapses the previously 3-4x duplicated "set refresh cookie + shape the
// login/register JSON response" block (one per auth endpoint) behind a single call.
function respondWithAuth(res: Response, status: number, message: string, result: AuthResult) {
  res.cookie("refreshToken", result.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: REFRESH_COOKIE_MAX_AGE,
  });
  res.status(status).json({
    message,
    user: result.user,
    token: result.accessToken,
    refreshToken: result.refreshToken,
  });
}

export const login = asyncHandler(async (req, res) => {
  const { username, password } = parseOrThrow(loginSchema, req.body);
  const result = await authService.loginGeneral(username, password);
  respondWithAuth(res, 200, "Login successful", result);
});

export const riderLogin = asyncHandler(async (req, res) => {
  const { username, password } = parseOrThrow(loginSchema, req.body);
  const result = await authService.loginRider(username, password);
  respondWithAuth(res, 200, "Login successful", result);
});

export const customerLogin = asyncHandler(async (req, res) => {
  const { username, password } = parseOrThrow(loginSchema, req.body);
  const result = await authService.loginCustomer(username, password);
  respondWithAuth(res, 200, "Login successful", result);
});

export const customerRegister = asyncHandler(async (req, res) => {
  const input = parseOrThrow(customerRegisterSchema, req.body);
  const result = await authService.registerCustomer(input);
  respondWithAuth(res, 201, "Customer registered successfully", result);
});

export const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ error: "Refresh token required." });
  }
  const { accessToken, user } = await authService.refreshAccessToken(refreshToken);
  res.status(200).json({ token: accessToken, user });
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

  if (req.user?.id) {
    void riderPresenceService.closeLoginSession(req.user.id);
  }

  res.clearCookie("refreshToken");
  res.status(200).json({ message: "Logged out successfully." });
});
