import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { isRevoked } from "../lib/blocklistCache.js";
import { logger } from "../lib/logger.js";
import { JWT_SECRET } from "../config/env.js";

export interface TokenPayload {
  id: number;
  username: string;
  email: string;
  role: string;
}

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

// Authentication Middleware (Verifies Bearer JWT Token + Token Blocklist)
export async function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token required. Please log in." });
  }

  try {
    // Check the in-process blocklist cache first (lib/blocklistCache.ts) — only
    // falls through to Prisma on a cache miss.
    if (await isRevoked(token)) {
      return res.status(401).json({ error: "Token has been revoked. Please log in again." });
    }

    jwt.verify(token, JWT_SECRET, (err: jwt.VerifyErrors | null, decoded: unknown) => {
      if (err) {
        return res.status(401).json({ error: "Invalid or expired token." });
      }
      req.user = decoded as TokenPayload;
      next();
    });
  } catch (error) {
    logger.error("Authentication middleware error:", error);
    return res.status(500).json({ error: "Internal server error verifying token." });
  }
}

// Role-Based Authorization Middleware
export function requireRole(allowedRoles: string | string[]) {
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  const normalizedAllowed = rolesArray.map((r) => String(r).toUpperCase());

  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: "User context missing." });
    }
    const userRole = String(req.user.role).toUpperCase();
    if (!normalizedAllowed.includes(userRole)) {
      return res.status(403).json({ error: `Access denied. Role ${userRole} is not authorized for this resource.` });
    }
    next();
  };
}
