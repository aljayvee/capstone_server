import { Router } from "express";
import {
  login,
  riderLogin,
  refresh,
  logout,
  completeLoginProfile,
  verifyLoginOtp,
  resendLoginOtp,
} from "../controllers/authController.js";
import { authenticateToken } from "../middleware/auth.js";
import { loginLimiter, verificationLimiter } from "../middleware/rateLimiters.js";

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

export default router;
