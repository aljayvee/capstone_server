import { Request, Response } from "express";
import {
  loginSysAdmin,
  completeSysAdminProfile,
  verifySysAdminMagicLink,
  resendSysAdminMagicLink,
  getSysAdminProfile,
  verifySysAdmin2Fa,
  resendSysAdmin2Fa,
  unlockSysAdminAccount,
  refreshSysAdminSession,
  toggleSysAdminTwoFactor,
  listSysAdminTrustedDevices,
  revokeSysAdminTrustedDevice,
} from "../services/sysAdminAuthService.js";
import { getClientIp, getDeviceId, getUserAgent } from "../lib/requestContext.js";
import { REFRESH_SESSION_TTL_MS, COOKIE_DOMAIN, CROSS_SITE_COOKIES } from "../config/env.js";
import { ServiceError } from "../services/ServiceError.js";
import * as sessionService from "../services/sessionService.js";
import { parseOrThrow } from "../validators/validate.js";
import {
  sysAdminLoginSchema,
  sysAdmin2FaVerifySchema,
  sysAdmin2FaResendSchema,
  sysAdminUnlockAccountSchema,
  sysAdminToggle2FaSchema,
} from "../validators/sysAdminValidators.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function getCookieDomain(): string | undefined {
  if (COOKIE_DOMAIN) return COOKIE_DOMAIN;
  if (process.env.NODE_ENV === "production") return ".sugo-express.org";
  return undefined;
}

function isSecureCookie(): boolean {
  return CROSS_SITE_COOKIES || process.env.NODE_ENV === "production";
}

function setSysAdminRefreshCookie(res: Response, refreshToken: string) {
  const domain = getCookieDomain();
  const secure = isSecureCookie();
  res.cookie("sysAdminRefreshToken", refreshToken, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/api/sysadmin/auth/",
    ...(domain ? { domain } : {}),
    maxAge: REFRESH_SESSION_TTL_MS,
  });
  // Also set fallback cookie for compatibility
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/",
    ...(domain ? { domain } : {}),
    maxAge: REFRESH_SESSION_TTL_MS,
  });
}

function setDeviceTrustCookie(res: Response, deviceToken: string) {
  const domain = getCookieDomain();
  const secure = isSecureCookie();
  res.cookie("sysAdminDeviceToken", deviceToken, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/api/sysadmin/auth/",
    ...(domain ? { domain } : {}),
    maxAge: THIRTY_DAYS_MS,
  });
}

function clearSysAdminCookies(res: Response) {
  const domain = getCookieDomain();
  const secure = isSecureCookie();
  const cookieOpts = {
    httpOnly: true,
    secure,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    ...(domain ? { domain } : {}),
  };
  res.clearCookie("sysAdminRefreshToken", {
    ...cookieOpts,
    path: "/api/sysadmin/auth/",
  });
  res.clearCookie("refreshToken", {
    ...cookieOpts,
    path: "/",
  });
}

function getAppOrigin(req: Request): string {
  const origin = req.headers.origin || req.headers.referer;
  if (origin && typeof origin === "string") {
    try {
      const parsed = new URL(origin);
      return parsed.origin;
    } catch {
      // Fallback
    }
  }
  return process.env.NODE_ENV === "production" ? "https://portal.sugo-express.org" : "http://localhost:5173";
}

export async function sysAdminLogin(req: Request, res: Response) {
  try {
    const validated = parseOrThrow(sysAdminLoginSchema, req.body);
    const context = {
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      deviceId: getDeviceId(req),
      deviceToken: (req.cookies && req.cookies.sysAdminDeviceToken) || null,
      appOrigin: getAppOrigin(req),
    };

    const result = await loginSysAdmin(validated.username, validated.password, context);

    if (result.profileSetupRequired) {
      return res.status(200).json({
        message: "First-time setup required.",
        profileSetupRequired: true,
        twoFactorRequired: false,
        challengeToken: result.challengeToken,
        admin: result.admin,
      });
    }

    if (result.twoFactorRequired) {
      return res.status(200).json({
        message: "Two-Factor Authentication required.",
        profileSetupRequired: false,
        twoFactorRequired: true,
        challengeToken: result.challengeToken,
        emailMasked: result.emailMasked,
        admin: result.admin,
      });
    }

    if (result.refreshToken) {
      setSysAdminRefreshCookie(res, result.refreshToken);
    }

    return res.status(200).json({
      message: "System Administrator authentication successful.",
      profileSetupRequired: false,
      twoFactorRequired: false,
      user: result.user,
      token: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
    });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Authentication error.";
    return res.status(500).json({ error: message });
  }
}

export async function sysAdminVerify2FaHandler(req: Request, res: Response) {
  try {
    const validated = parseOrThrow(sysAdmin2FaVerifySchema, req.body);
    const context = {
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      deviceId: getDeviceId(req),
      appOrigin: getAppOrigin(req),
    };

    const result = await verifySysAdmin2Fa(
      validated.challengeToken,
      validated.code,
      validated.trustDevice,
      validated.deviceFingerprint,
      context
    );

    if (result.deviceToken) {
      setDeviceTrustCookie(res, result.deviceToken);
    }

    if (result.refreshToken) {
      setSysAdminRefreshCookie(res, result.refreshToken);
    }

    return res.status(200).json({
      message: "Two-Factor Authentication verified successfully.",
      user: result.user,
      token: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
    });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Two-factor verification failed.";
    return res.status(400).json({ error: message });
  }
}

export async function sysAdminResend2FaHandler(req: Request, res: Response) {
  try {
    const validated = parseOrThrow(sysAdmin2FaResendSchema, req.body);
    const context = {
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      deviceId: getDeviceId(req),
      appOrigin: getAppOrigin(req),
    };

    const result = await resendSysAdmin2Fa(validated.challengeToken, context);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Resend code error.";
    return res.status(400).json({ error: message });
  }
}

export async function sysAdminUnlockAccountHandler(req: Request, res: Response) {
  try {
    const rawToken = (req.query.token as string) || (req.body?.token as string);
    const validated = parseOrThrow(sysAdminUnlockAccountSchema, { token: rawToken });

    const result = await unlockSysAdminAccount(validated.token);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Account unlock error.";
    return res.status(400).json({ error: message });
  }
}

export async function sysAdminRefreshHandler(req: Request, res: Response) {
  try {
    const refreshToken =
      req.cookies?.sysAdminRefreshToken ||
      req.cookies?.refreshToken ||
      req.body?.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({ error: "Missing refresh token." });
    }

    const context = {
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      deviceId: getDeviceId(req),
    };

    const result = await refreshSysAdminSession(refreshToken, context);

    if (result.refreshToken) {
      setSysAdminRefreshCookie(res, result.refreshToken);
    }

    return res.status(200).json({
      token: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });
  } catch (err: unknown) {
    clearSysAdminCookies(res);
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

export async function sysAdminCompleteProfile(req: Request, res: Response) {
  try {
    const { challengeToken, firstName, lastName, middleName, nickname, email } = req.body;
    if (!challengeToken) {
      return res.status(400).json({ error: "Challenge token is required." });
    }

    const appOrigin = getAppOrigin(req);
    const result = await completeSysAdminProfile(
      challengeToken,
      { firstName, lastName, middleName, nickname, email },
      appOrigin
    );

    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Profile completion error.";
    return res.status(500).json({ error: message });
  }
}

export async function sysAdminVerifyMagicLink(req: Request, res: Response) {
  try {
    const token = (req.query.token as string) || (req.body?.token as string);
    const context = {
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      deviceId: getDeviceId(req),
    };

    const result = await verifySysAdminMagicLink(token, context);

    if (result.refreshToken) {
      setSysAdminRefreshCookie(res, result.refreshToken);
    }

    return res.status(200).json({
      message: result.message,
      user: result.user,
      token: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
    });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Verification link error.";
    return res.status(400).json({ error: message });
  }
}

export async function sysAdminResendMagicLink(req: Request, res: Response) {
  try {
    const { challengeToken } = req.body;
    if (!challengeToken) {
      return res.status(400).json({ error: "Challenge token is required." });
    }

    const appOrigin = getAppOrigin(req);
    const result = await resendSysAdminMagicLink(challengeToken, appOrigin);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Resend link error.";
    return res.status(500).json({ error: message });
  }
}

export async function sysAdminMe(req: AuthenticatedRequest, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const profile = await getSysAdminProfile(adminId);
    return res.status(200).json({ user: profile });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to fetch administrator profile." });
  }
}

export async function sysAdminLogout(req: AuthenticatedRequest, res: Response) {
  try {
    const sessionId = (req.body && req.body.sessionId) || null;
    if (sessionId) {
      await sessionService.revokeSession(sessionId, "SYSADMIN_LOGOUT");
    }
    clearSysAdminCookies(res);
    return res.status(200).json({ message: "System Administrator logged out successfully." });
  } catch {
    clearSysAdminCookies(res);
    return res.status(200).json({ message: "Logged out." });
  }
}

export async function sysAdminToggle2FaHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ error: "Unauthorized." });

    const validated = parseOrThrow(sysAdminToggle2FaSchema, req.body);
    const result = await toggleSysAdminTwoFactor(adminId, validated.enforceTwoFactor, validated.stepUpPassword);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to update 2FA configuration.";
    return res.status(400).json({ error: message });
  }
}

export async function sysAdminGetTrustedDevicesHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ error: "Unauthorized." });

    const devices = await listSysAdminTrustedDevices(adminId);
    return res.status(200).json({ devices });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to load trusted devices." });
  }
}

export async function sysAdminRevokeTrustedDeviceHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ error: "Unauthorized." });

    const { deviceId } = req.params;
    if (!deviceId) return res.status(400).json({ error: "Device ID required." });

    const result = await revokeSysAdminTrustedDevice(adminId, deviceId);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(400).json({ error: "Failed to revoke trusted device." });
  }
}
