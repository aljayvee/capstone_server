import type { Request } from "express";
import { logger } from "./logger.js";
import { getClientIp } from "./requestContext.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

/**
 * One `[AuthZ]` line for a refused request: the status, the route, who asked
 * and from where. Refusals are the trail an id-guessing or password-guessing
 * probe leaves, and until 2026-11-02 they reached the client and nowhere else.
 *
 * Shared by errorHandler (refusals thrown as ServiceError) and the middleware
 * that answers 401/403 itself (auth.ts, sysAdminSecurity.ts), so every refusal
 * reads the same in the log. The query string is dropped: some links carry
 * tokens there.
 *
 * Never throws. A log line that failed would turn a clean 401/403 into a 500.
 */
export function logRefusal(req: Request, status: 401 | 403, reason: string): void {
  try {
    const user = (req as AuthenticatedRequest).user;
    const path = String(req.originalUrl ?? req.url ?? "").split("?")[0];
    logger.warn(
      `[AuthZ] ${status} on ${req.method} ${path} for ${
        user ? `${user.role} #${user.id}` : "a signed-out caller"
      } from ${getClientIp(req) ?? "an unknown IP"}: ${reason}`
    );
  } catch {
    // The refusal itself still goes out; only its log line is lost.
  }
}
