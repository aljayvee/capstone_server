import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { logRefusal } from "../lib/authzLog.js";
import type { AuthenticatedRequest } from "./auth.js";

const isDev = process.env.NODE_ENV === "development" || !process.env.NODE_ENV;

/**
 * 1. Dedicated SysAdmin Login Limiter (Anti-Brute-Force & Credential Stuffing)
 * Max 5 failed attempts per 15-minute sliding window per IP.
 * Only failed attempts count against the limit (skipSuccessfulRequests).
 */
export const sysAdminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 100 : 5, // 5 failed attempts in production
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many failed administrative login attempts. For security, access is temporarily locked. Please try again after 15 minutes.",
  },
});

/**
 * 2. Tiered Mutation Limiter: Database Backups
 * Max 3 backup runs per hour per authenticated administrator.
 */
export const sysAdminBackupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDev ? 30 : 3,
  keyGenerator: (req: any) => (req.user?.id ? `sysadmin_backup_${req.user.id}` : (req.ip || "127.0.0.1")),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Database backup rate limit exceeded. A maximum of 3 backups per hour is permitted.",
  },
});

/**
 * 3. Tiered Mutation Limiter: Maintenance Mode Toggles
 * Max 10 toggle operations per 10 minutes.
 */
export const sysAdminMaintenanceLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: isDev ? 50 : 10,
  keyGenerator: (req: any) => (req.user?.id ? `sysadmin_maint_${req.user.id}` : (req.ip || "127.0.0.1")),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Maintenance toggle rate limit exceeded. Please wait a few minutes before making further adjustments.",
  },
});

/**
 * 4. Tiered Mutation Limiter: Account & Permission Modifications
 * Max 30 writes per 5 minutes per administrator.
 */
export const sysAdminMutationLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: isDev ? 150 : 30,
  keyGenerator: (req: any) => (req.user?.id ? `sysadmin_mut_${req.user.id}` : (req.ip || "127.0.0.1")),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Administrative write rate limit reached. Please wait a few moments before trying again.",
  },
});

/**
 * 5. SysAdmin CSRF & Client Identity Verification
 * Enforces dual CSRF defense:
 * 1. Checks Origin/Referer against allowed domains.
 * 2. Requires custom header `X-SysAdmin-Client: sugo-sysadmin-web` on mutating requests.
 */
export function verifySysAdminCsrf(req: Request, res: Response, next: NextFunction) {
  // Safe HTTP methods do not mutate state
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }

  // 1. Client header verification
  const clientHeader = req.headers["x-sysadmin-client"];
  if (clientHeader !== "sugo-sysadmin-web") {
    logRefusal(req, 403, "CSRF check: missing or wrong X-SysAdmin-Client header");
    return res.status(403).json({
      error: "CSRF protection: Missing or invalid X-SysAdmin-Client header.",
    });
  }

  // 2. Origin / Referer validation
  const origin = req.headers.origin || req.headers.referer;
  if (origin && typeof origin === "string") {
    try {
      const parsed = new URL(origin);
      const allowedHosts = [
        "sugo-express.org",
        "api.sugo-express.org",
        "sugoonthego.online",
        "localhost",
        "127.0.0.1",
      ];
      const isAllowed = allowedHosts.some(
        (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
      );
      if (!isAllowed) {
        logRefusal(req, 403, `CSRF check: origin ${parsed.origin} is not allowed`);
        return res.status(403).json({
          error: `CSRF protection: Unauthorized origin '${parsed.origin}'.`,
        });
      }
    } catch {
      logRefusal(req, 403, "CSRF check: malformed Origin/Referer");
      return res.status(403).json({ error: "CSRF protection: Malformed origin header." });
    }
  }

  next();
}

/**
 * 6. Hardened Security Headers Middleware for /sysadmin
 */
export function setSysAdminSecurityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; default-src 'self'");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
}

/**
 * 7. Block Known Tor / Anonymous Proxies
 */
export function blockTorAndProxies(req: Request, res: Response, next: NextFunction) {
  const headers = req.headers;
  const suspiciousProxyHeaders = [
    "x-tor",
    "x-tor-exit-node",
    "via-tor",
    "x-anonymous-proxy",
  ];

  for (const header of suspiciousProxyHeaders) {
    if (headers[header]) {
      logRefusal(req, 403, `anonymous-proxy header ${header}`);
      return res.status(403).json({
        error: "Access denied: Connecting through known Tor exit nodes or anonymous proxies is restricted for the administrative portal.",
      });
    }
  }

  next();
}

/**
 * 8. Step-Up Re-Authentication Middleware
 * Verifies current IT Admin password before sensitive actions (backups, account termination, IT admin creation).
 */
export async function verifyStepUpPassword(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      logRefusal(req, 401, "no signed-in admin at a step-up check");
      return res.status(401).json({ error: "Authentication required." });
    }

    const password = req.body?.stepUpPassword || req.headers["x-step-up-password"];
    if (!password || typeof password !== "string") {
      logRefusal(req, 403, "no step-up password");
      return res.status(403).json({
        error: "Step-up re-authentication required. Please provide your current administrator password to confirm this action.",
        stepUpRequired: true,
      });
    }

    const admin = await prisma.sysAdmin.findUnique({
      where: { id: adminId },
      select: { passwordHash: true, status: true },
    });

    if (!admin || admin.status !== "Active") {
      logRefusal(req, 401, "admin account missing or not Active at a step-up check");
      return res.status(401).json({ error: "Administrative session invalid or suspended." });
    }

    const isValid = await bcrypt.compare(password, admin.passwordHash);
    if (!isValid) {
      logRefusal(req, 403, "wrong step-up password");
      return res.status(403).json({
        error: "Step-up re-authentication failed: incorrect administrator password.",
        stepUpRequired: true,
      });
    }

    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Step-up authentication error.";
    return res.status(500).json({ error: message });
  }
}
