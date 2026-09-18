import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";
import { ServiceError } from "../services/ServiceError.js";
import {
  firebaseConfigurationError,
  isFirebaseConfigured,
  mintCustomToken,
} from "../lib/firebaseAdmin.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

/**
 * POST /api/auth/firebase-token — a Firebase identity for the caller's session.
 *
 * Deliberately its own endpoint rather than an extra field on the login
 * response. The JWT authentication architecture is a [LOCKED] contract, and
 * three client apps parse that response shape; widening it to carry a fourth
 * token would change a locked interface for every one of them at once, for a
 * value two of the three do not need on the login path itself.
 *
 * As a separate call it is also independently retryable, which matters because
 * this one can fail on its own: an unconfigured service account must leave the
 * user signed in and the API working, with only the real-time surfaces
 * degraded.
 *
 * The caller's identity comes from `authenticateToken`, never from the body. A
 * uid taken from a request parameter would let any signed-in account mint a
 * Firebase identity for any other, which is precisely the impersonation the
 * security rules are being introduced to prevent.
 */
export const issueFirebaseToken = asyncHandler<AuthenticatedRequest>(
  async (req, res: Response) => {
    if (!isFirebaseConfigured()) {
      // 503, not 500: this is a configuration gap an operator can close, and
      // the client is expected to carry on without real-time rather than treat
      // it as a broken session and sign the user out.
      throw new ServiceError(
        503,
        firebaseConfigurationError() ||
          "Real-time authentication is not configured on this server."
      );
    }

    const { id, role } = req.user!;

    try {
      const { token, uid, claims } = await mintCustomToken(role, id);
      return res.json({
        success: true,
        token,
        uid,
        role: claims.role,
        // The custom token itself is single-use and short-lived; the session it
        // opens is refreshed by the client SDK. Sent so a client can decide how
        // long to cache the unspent token, not as a session length.
        expiresInSeconds: 3600,
      });
    } catch (error) {
      logger.error(`Failed to mint a Firebase token for ${role} ${id}:`, error);
      throw new ServiceError(503, "Could not issue a real-time credential. Try again shortly.");
    }
  }
);
