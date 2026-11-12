import { Router } from "express";
import {
  customerLogin,
  customerRegister,
  customerGoogleLogin,
  customerGoogleRegister,
  forgotPassword,
  verifyResetCode,
  verifyResetPhone,
  resetPassword,
} from "../controllers/authController.js";
import {
  getCustomerProfile,
  updateCustomerProfile,
  uploadCustomerPhoto,
  getCustomerPhoto,
  registerCustomerPushToken,
  deleteCustomerPhoto,
  getCustomerTransactions,
  verifyEmail,
  resendVerificationEmail,
  sendRegistrationOtp,
  verifyRegistrationOtp,
  sendRegistrationPhoneOtp,
  verifyRegistrationPhoneOtp,
  verifyFirebasePhone,
  getCustomerModificationLogs,
} from "../controllers/customerController.js";
import { authenticateToken, optionalAuthenticateToken } from "../middleware/auth.js";
import {
  loginLimiter,
  userApiLimiter,
  readLimiter,
  verificationLimiter,
  passwordResetLimiter,
} from "../middleware/rateLimiters.js";

const router = Router();

// Literal routes MUST be declared before the /:id param routes below, otherwise
// Express would match "register"/"login"/etc. as an :id value.
router.post("/register", userApiLimiter, customerRegister);
router.post("/login", loginLimiter, customerLogin);
router.post("/google-login", loginLimiter, customerGoogleLogin);
router.post("/google-register", userApiLimiter, customerGoogleRegister);
router.post("/send-registration-otp", verificationLimiter, sendRegistrationOtp);
router.post("/verify-registration-otp", verificationLimiter, verifyRegistrationOtp);
router.post("/send-registration-phone-otp", verificationLimiter, sendRegistrationPhoneOtp);
router.post("/verify-registration-phone-otp", verificationLimiter, verifyRegistrationPhoneOtp);
router.post("/verify-phone-firebase", verificationLimiter, optionalAuthenticateToken, verifyFirebasePhone);
router.post("/verify-email", verificationLimiter, verifyEmail);
// Password reset. All three are unauthenticated by necessity — the whole point
// is that the caller cannot sign in — so each carries the IP-keyed limiter, and
// the service behind them writes an audit row per attempt.
router.post("/forgot-password", passwordResetLimiter, forgotPassword);
router.post("/verify-reset-code", passwordResetLimiter, verifyResetCode);
router.post("/verify-reset-phone", passwordResetLimiter, verifyResetPhone);
router.post("/reset-password", passwordResetLimiter, resetPassword);

router.post("/resend-verification-email", verificationLimiter, resendVerificationEmail);

router.get("/:id", authenticateToken, readLimiter, getCustomerProfile);
router.put("/:id", authenticateToken, userApiLimiter, updateCustomerProfile);
router.post("/:id/push-token", authenticateToken, userApiLimiter, registerCustomerPushToken);
// No sign-in: a signed link the customer's own profile response hands out.
router.get("/:id/photo", readLimiter, getCustomerPhoto);
router.put("/:id/photo", authenticateToken, userApiLimiter, uploadCustomerPhoto);
router.delete("/:id/photo", authenticateToken, userApiLimiter, deleteCustomerPhoto);
router.get("/:id/transactions", authenticateToken, readLimiter, getCustomerTransactions);
router.get("/:id/modification-logs", authenticateToken, readLimiter, getCustomerModificationLogs);

export default router;
