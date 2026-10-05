/**
 * threatInterceptor.ts
 *
 * Express middleware that intercepts all incoming requests to enforce:
 *  1. Whitelist bypass
 *  2. In-memory IP blacklist enforcement (HTTP 403)
 *  3. Heuristic directory & vulnerability probe auto-banning (Instant Permanent Ban)
 */

import { Request, Response, NextFunction } from "express";
import { sysAdminThreatService } from "../services/sysAdminThreatService.js";
import { logger } from "../lib/logger.js";

const MALICIOUS_PATH_PATTERNS = [
  /^\/(\.env|\.git|\.aws|\.DS_Store|wp-admin|wp-login|phpmyadmin|adminer|config\.json|docker-compose\.yml|id_rsa)/i,
  /(\.\.[\/\\])/, // Path traversal attempts
  /(\.php|\.asp|\.aspx|\.jsp|\.cgi)$/i, // Legacy server file probes on Node API
  /^\/(vendor|cgi-bin|autodiscover|solr|actuator)/i, // Vulnerability scanners
];

/**
 * Extracts and normalizes the client IP address.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  let ip = "";
  if (typeof forwarded === "string") {
    ip = forwarded.split(",")[0].trim();
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    ip = forwarded[0].trim();
  } else {
    ip = req.ip || req.socket.remoteAddress || "127.0.0.1";
  }
  return ip.replace(/^::ffff:/, "").trim();
}

export const threatInterceptor = (req: Request, res: Response, next: NextFunction): void => {
  const clientIp = getClientIp(req);

  // 1. Whitelist Check (Immune priority bypass)
  if (sysAdminThreatService.isIpWhitelisted(clientIp)) {
    return next();
  }

  // 2. Blacklist Check (Instant drop)
  const banStatus = sysAdminThreatService.checkIpBlocked(clientIp);
  if (banStatus.isBlocked) {
    logger.warn(`[ThreatInterceptor] Blocked banned request from ${clientIp} to ${req.path}`);
    res.status(403).json({
      error: "Access Denied",
      message: "Your IP address has been blacklisted by automated security enforcement policies.",
      reason: banStatus.reason,
      blockedUntil: banStatus.blockedUntil,
    });
    return;
  }

  // 3. Directory Probe & Vulnerability Scanner Heuristics
  const normalizedPath = req.path.toLowerCase();
  const isMaliciousProbe = MALICIOUS_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));

  if (isMaliciousProbe) {
    logger.warn(`[ThreatInterceptor] Malicious probe detected from ${clientIp}: ${req.path}. Enforcing permanent auto-ban.`);

    // Auto-ban immediately
    sysAdminThreatService
      .blockIp({
        ipAddress: clientIp,
        reason: `Malicious directory/vulnerability scan: ${req.path.slice(0, 100)}`,
        banType: "AUTOMATIC",
        severity: "CRITICAL",
        durationHours: null, // Permanent
        metadata: {
          path: req.path,
          method: req.method,
          userAgent: req.headers["user-agent"],
          timestamp: new Date().toISOString(),
        },
      })
      .catch((err) => {
        logger.error(`[ThreatInterceptor] Failed to record auto-ban for ${clientIp}:`, err);
      });

    res.status(403).json({
      error: "Access Denied",
      message: "Malicious scanning probe detected. Your IP address has been permanently blacklisted.",
    });
    return;
  }

  next();
};
