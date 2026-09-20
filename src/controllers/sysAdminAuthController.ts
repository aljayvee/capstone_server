import { Request, Response } from "express";
import {
  loginSysAdmin,
  completeSysAdminProfile,
  verifySysAdminMagicLink,
  resendSysAdminMagicLink,
  getSysAdminProfile,
} from "../services/sysAdminAuthService.js";
import { getClientIp, getDeviceId, getUserAgent } from "../lib/requestContext.js";
import { REFRESH_SESSION_TTL_MS } from "../config/env.js";
import { ServiceError } from "../services/ServiceError.js";
import * as sessionService from "../services/sessionService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const CROSS_SITE_COOKIES = process.env.CROSS_SITE_COOKIES === "true";

function setRefreshCookie(res: Response, refreshToken: string) {
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: CROSS_SITE_COOKIES || process.env.NODE_ENV === "production",
    sameSite: CROSS_SITE_COOKIES ? "none" : "lax",
    maxAge: REFRESH_SESSION_TTL_MS,
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
  return process.env.NODE_ENV === "production" ? "https://sugo-express.org" : "http://localhost:5173";
}

export async function sysAdminLogin(req: Request, res: Response) {
  try {
    const { username, password } = req.body;
    const context = {
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      deviceId: getDeviceId(req),
    };

    const result = await loginSysAdmin(username, password, context);

    if (result.profileSetupRequired) {
      return res.status(200).json({
        message: "First-time setup required.",
        profileSetupRequired: true,
        challengeToken: result.challengeToken,
        admin: result.admin,
      });
    }

    if (result.refreshToken) {
      setRefreshCookie(res, result.refreshToken);
    }

    return res.status(200).json({
      message: "System Administrator authentication successful.",
      profileSetupRequired: false,
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
      setRefreshCookie(res, result.refreshToken);
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
    res.clearCookie("refreshToken");
    return res.status(200).json({ message: "System Administrator logged out successfully." });
  } catch {
    res.clearCookie("refreshToken");
    return res.status(200).json({ message: "Logged out." });
  }
}
