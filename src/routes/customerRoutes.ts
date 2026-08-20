import { Router } from "express";
import { customerLogin, customerRegister } from "../controllers/authController.js";
import {
  getCustomerProfile,
  updateCustomerProfile,
  uploadCustomerPhoto,
  deleteCustomerPhoto,
  getCustomerTransactions,
  verifyEmail,
  resendVerificationEmail,
  sendRegistrationOtp,
  verifyRegistrationOtp,
  sendRegistrationPhoneOtp,
  verifyRegistrationPhoneOtp,
  getCustomerModificationLogs,
} from "../controllers/customerController.js";
import { authenticateToken } from "../middleware/auth.js";
import { loginLimiter, userApiLimiter, readLimiter, verificationLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// Literal routes MUST be declared before the /:id param routes below, otherwise
// Express would match "register"/"login"/etc. as an :id value.
router.post("/register", userApiLimiter, customerRegister);
router.post("/login", loginLimiter, customerLogin);
router.post("/send-registration-otp", verificationLimiter, sendRegistrationOtp);
router.post("/verify-registration-otp", verificationLimiter, verifyRegistrationOtp);
router.post("/send-registration-phone-otp", verificationLimiter, sendRegistrationPhoneOtp);
router.post("/verify-registration-phone-otp", verificationLimiter, verifyRegistrationPhoneOtp);
router.post("/verify-email", verificationLimiter, verifyEmail);
router.post("/resend-verification-email", verificationLimiter, resendVerificationEmail);

router.get("/:id", authenticateToken, readLimiter, getCustomerProfile);
router.put("/:id", authenticateToken, userApiLimiter, updateCustomerProfile);
router.put("/:id/photo", authenticateToken, userApiLimiter, uploadCustomerPhoto);
router.delete("/:id/photo", authenticateToken, userApiLimiter, deleteCustomerPhoto);
router.get("/:id/transactions", authenticateToken, readLimiter, getCustomerTransactions);
router.get("/:id/modification-logs", authenticateToken, readLimiter, getCustomerModificationLogs);

export default router;
