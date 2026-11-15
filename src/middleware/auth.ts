import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { isRevoked } from "../lib/blocklistCache.js";
import { logger } from "../lib/logger.js";
import { logRefusal } from "../lib/authzLog.js";
import { JWT_SECRET } from "../config/env.js";
import { getPermission, scopeOfRole, type PermissionScope } from "../lib/permissions.js";
import { getEffectivePermissions } from "../lib/permissionCache.js";
import { isMainOwner } from "../lib/mainOwner.js";
import { getSysAdminPermission } from "../lib/sysAdminPermissions.js";
import { getEffectiveSysAdminPermissions } from "../lib/sysAdminPermissionCache.js";
import { isMainSysAdmin } from "../lib/mainSysAdmin.js";

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
    logRefusal(req, 401, "no access token");
    return res.status(401).json({ error: "Access token required. Please log in." });
  }

  try {
    // Check the in-process blocklist cache first (lib/blocklistCache.ts) — only
    // falls through to Prisma on a cache miss.
    if (await isRevoked(token)) {
      logRefusal(req, 401, "revoked access token");
      return res.status(401).json({ error: "Token has been revoked. Please log in again." });
    }

    jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }, (err: jwt.VerifyErrors | null, decoded: unknown) => {
      if (err) {
        // Expiry is routine: every client's 15-minute token lapses, and the
        // refresh interceptor recovers. Logging it would bury the forged and
        // malformed tokens this line exists to show.
        if (err.name !== "TokenExpiredError") {
          logRefusal(req, 401, `invalid access token (${err.message})`);
        }
        return res.status(401).json({ error: "Invalid or expired token." });
      }

      // Only fully-authenticated session tokens get past here. A pre-auth
      // login-challenge token is already unable to reach this point because it
      // is signed with JWT_CHALLENGE_SECRET, not JWT_SECRET — this check exists
      // to catch the refactor that someday "simplifies" those two back into
      // one. A payload carrying `purpose`, or missing `role`/`id`, is not a
      // session token no matter what signed it.
      const claims = decoded as Partial<TokenPayload> & { purpose?: string };
      if (claims?.purpose || !claims?.role || !claims?.id) {
        logRefusal(req, 401, "a token that is not a session token");
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

// Optional Authentication Middleware (Attaches req.user if valid token present, allows unauthenticated callers through)
export async function optionalAuthenticateToken(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return next();
  }

  try {
    if (await isRevoked(token)) {
      return next();
    }

    jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }, (err: jwt.VerifyErrors | null, decoded: unknown) => {
      if (!err && decoded) {
        const claims = decoded as Partial<TokenPayload> & { purpose?: string };
        if (!claims?.purpose && claims?.role && claims?.id) {
          req.user = decoded as TokenPayload;
        }
      }
      next();
    });
  } catch {
    next();
  }
}

// Role-Based Authorization Middleware
export function requireRole(allowedRoles: string | string[]) {
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  const normalizedAllowed = rolesArray.map((r) => String(r).toUpperCase());

  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !req.user.role) {
      logRefusal(req, 401, "no signed-in user at a role check");
      return res.status(401).json({ error: "User context missing." });
    }
    const userRole = String(req.user.role).toUpperCase();
    if (!normalizedAllowed.includes(userRole)) {
      logRefusal(req, 403, `role ${userRole} is not one of ${normalizedAllowed.join(", ")}`);
      return res.status(403).json({ error: `Access denied. Role ${userRole} is not authorized for this resource.` });
    }
    next();
  };
}

/**
 * A key from lib/permissions.ts, or one key per role for a route both roles
 * share: `{ OWNER: "tracking.view" }` gates Admins and leaves dispatchers to
 * requireRole alone.
 */
export type PermissionSpec = string | Partial<Record<PermissionScope, string>>;

// Access-group check. Goes AFTER requireRole, which still decides who may use
// a route at all; this narrows it for accounts in a restricted group. A caller
// whose role the spec does not name passes through untouched, so an Admin on a
// dispatcher route behaves exactly as before groups existed.
//
// Fails closed: when the check itself cannot run, the answer is 503, never a
// pass.
export function requirePermission(spec: PermissionSpec) {
  const byScope: Partial<Record<PermissionScope, string>> = {};
  for (const key of typeof spec === "string" ? [spec] : Object.values(spec)) {
    const permission = key ? getPermission(key) : undefined;
    // A typo here would silently gate nobody, so it stops the server at boot.
    if (!permission) throw new Error(`requirePermission: unknown permission key "${key}"`);
    if (typeof spec !== "string" && spec[permission.scope] !== key) {
      throw new Error(`requirePermission: "${key}" is a ${permission.scope} key`);
    }
    byScope[permission.scope] = key;
  }

  // Named so route-shape tests can find it in a chain.
  return async function requirePermissionGuard(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const scope = scopeOfRole(req.user?.role);
    const key = scope ? byScope[scope] : undefined;
    if (!key) return next();
    try {
      const effective = await getEffectivePermissions(req.user!.id, req.user!.role);
      if (effective?.permissions.includes(key)) return next();
      logRefusal(req, 403, `access group lacks ${key}`);
      return res.status(403).json({
        error: `Your access group does not include ${getPermission(key)!.label}.`,
        code: "PERMISSION_DENIED",
        permission: key,
      });
    } catch (error) {
      logger.error(`Permission check for ${key} failed:`, error);
      return res.status(503).json({ error: "Your access could not be checked right now. Try again in a moment." });
    }
  };
}

// Access management and Admin accounts belong to the Main Owner alone
// (lib/mainOwner.ts). Use after requireRole(["OWNER"]).
export async function requireMainOwner(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (await isMainOwner(req.user?.id, req.user?.role)) return next();
    logRefusal(req, 403, "not the Main Owner");
    return res.status(403).json({
      error: "Only the Main Owner can manage access.",
      code: "MAIN_OWNER_ONLY",
    });
  } catch (error) {
    logger.error("Main Owner check failed:", error);
    return res.status(503).json({ error: "Your access could not be checked right now. Try again in a moment." });
  }
}

/**
 * SysAdmin PMA permission guard. Validates permission keys at boot so typos
 * fail fast, and fails closed (503) if the database/cache cannot be read.
 */
export function requireSysAdminPermission(key: string) {
  const permission = getSysAdminPermission(key);
  if (!permission) {
    throw new Error(`requireSysAdminPermission: unknown permission key "${key}"`);
  }

  return async function requireSysAdminPermissionGuard(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    if (!req.user || String(req.user.role ?? "").toUpperCase() !== "SYSADMIN") {
      logRefusal(req, 403, `non-sysadmin caller at ${key}`);
      return res.status(403).json({ error: "SysAdmin role required." });
    }
    try {
      const effective = await getEffectiveSysAdminPermissions(req.user.id);
      if (effective?.permissions.includes(key)) return next();
      logRefusal(req, 403, `sysadmin access group lacks ${key}`);
      return res.status(403).json({
        error: `Your access group does not include ${permission.label}.`,
        code: "PERMISSION_DENIED",
        permission: key,
      });
    } catch (error) {
      logger.error(`SysAdmin permission check for ${key} failed:`, error);
      return res.status(503).json({ error: "Your access could not be checked right now. Try again in a moment." });
    }
  };
}

/**
 * Root SysAdmin guard (lowest id in tbl_sys_admin). Use after requireRole("SYSADMIN").
 */
export async function requireMainSysAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (await isMainSysAdmin(req.user?.id, req.user?.role)) return next();
    logRefusal(req, 403, "not the Main SysAdmin");
    return res.status(403).json({
      error: "Only the Main SysAdmin or Main Owner can manage IT Admin access.",
      code: "MAIN_SYSADMIN_ONLY",
    });
  } catch (error) {
    logger.error("Main SysAdmin check failed:", error);
    return res.status(503).json({ error: "Your access could not be checked right now. Try again in a moment." });
  }
}
