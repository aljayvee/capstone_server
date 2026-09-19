import { Router } from "express";
import {
  login,
  riderLogin,
  refresh,
  logout,
  completeLoginProfile,
  verifyLoginOtp,
  resendLoginOtp,
  getActiveSessions,
  revokeSessionById,
  revokeOtherSessionsHandler,
  getLoginLogs,
} from "../controllers/authController.js";
import { issueFirebaseToken } from "../controllers/firebaseAuthController.js";
import { authenticateToken } from "../middleware/auth.js";
import { loginLimiter, verificationLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

router.post("/auth/login", loginLimiter, login);
router.post("/riders/login", loginLimiter, riderLogin);

// Deliberately on verificationLimiter rather than loginLimiter. These are
// post-password steps, and a 400 from fumbling the name/email rules would
// otherwise eat the 10-per-15-minute sign-in budget and lock the bootstrap
// admin out of their own first-run setup.
router.post("/auth/complete-profile", verificationLimiter, completeLoginProfile);
router.post("/auth/verify-login-otp", verificationLimiter, verifyLoginOtp);
router.post("/auth/resend-login-otp", verificationLimiter, resendLoginOtp);

router.post("/auth/refresh", refresh);
router.post("/auth/logout", authenticateToken, logout);

// Account Session Governance & Audit Logs
router.get("/account/sessions", authenticateToken, userApiLimiter, getActiveSessions);
router.delete("/account/sessions/:sessionId", authenticateToken, userApiLimiter, revokeSessionById);
router.post("/account/sessions/revoke-others", authenticateToken, userApiLimiter, revokeOtherSessionsHandler);
router.get("/account/login-logs", authenticateToken, userApiLimiter, getLoginLogs);

// POST /api/auth/firebase-token - a Firebase identity for an existing session.
//
// Called once after sign-in, and again only if the client finds itself without
// a Firebase session (a cold start, or a sign-out). userApiLimiter rather than
// loginLimiter: this is a post-authentication exchange, not a credential guess,
// and putting it on the sign-in budget would let a reconnect loop lock a user
// out of logging back in.
router.post("/auth/firebase-token", authenticateToken, userApiLimiter, issueFirebaseToken);

export default router;
