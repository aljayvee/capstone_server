import { Router } from "express";
import {
  sysAdminLogin,
  sysAdminCompleteProfile,
  sysAdminVerifyMagicLink,
  sysAdminResendMagicLink,
  sysAdminMe,
  sysAdminLogout,
} from "../controllers/sysAdminAuthController.js";
import {
  getMonitoredAccounts,
  getSessionsForAccount,
  terminateSession,
  updateAccountStatusHandler,
} from "../controllers/sysAdminUserController.js";
import {
  getAuthAuditLogs,
  getModificationAuditLogs,
  getSecurityAuditLogs,
  getSystemActivityLogs,
} from "../controllers/sysAdminAuditController.js";
import {
  getTrafficSummaryHandler,
  getGoAccessHtmlReportHandler,
} from "../controllers/sysAdminTrafficController.js";
import {
  getTelemetryHandler,
  toggleMaintenanceHandler,
  getPublicMaintenanceStatusHandler,
  triggerBackupHandler,
  listItAdminsHandler,
  createItAdminHandler,
} from "../controllers/sysAdminDevOpsController.js";
import {
  requestProfileOtpHandler,
  verifyProfileOtpHandler,
  updateProfileHandler,
} from "../controllers/sysAdminProfileController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { loginLimiter, verificationLimiter, readLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// SysAdmin Authentication & First-Login Setup Wizard
router.post("/sysadmin/auth/login", loginLimiter, sysAdminLogin);
router.post("/sysadmin/auth/complete-profile", verificationLimiter, sysAdminCompleteProfile);
router.get("/sysadmin/auth/verify-email", verificationLimiter, sysAdminVerifyMagicLink);
router.post("/sysadmin/auth/verify-email", verificationLimiter, sysAdminVerifyMagicLink);
router.post("/sysadmin/auth/resend-verification", verificationLimiter, sysAdminResendMagicLink);
router.post("/sysadmin/auth/logout", authenticateToken, requireRole("SYSADMIN"), sysAdminLogout);
router.get("/sysadmin/auth/me", authenticateToken, requireRole("SYSADMIN"), sysAdminMe);

// Profile Change Security Gate (3-layer: password + CONFIRM + email OTP)
router.post("/sysadmin/auth/request-profile-otp", authenticateToken, requireRole("SYSADMIN"), verificationLimiter, requestProfileOtpHandler);
router.post("/sysadmin/auth/verify-profile-otp", authenticateToken, requireRole("SYSADMIN"), verificationLimiter, verifyProfileOtpHandler);
router.patch("/sysadmin/auth/update-profile", authenticateToken, requireRole("SYSADMIN"), updateProfileHandler);

// Multi-Role User Account Monitoring & Security Actions
router.get("/sysadmin/users", authenticateToken, requireRole("SYSADMIN"), readLimiter, getMonitoredAccounts);
router.get("/sysadmin/users/:role/:id/sessions", authenticateToken, requireRole("SYSADMIN"), readLimiter, getSessionsForAccount);
router.post("/sysadmin/users/sessions/:sessionId/terminate", authenticateToken, requireRole("SYSADMIN"), terminateSession);
router.patch("/sysadmin/users/:role/:id/status", authenticateToken, requireRole("SYSADMIN"), updateAccountStatusHandler);

// Categorized Audit Logs Center (Auth, Account Changes, Security/Threats, System Lifecycle)
router.get("/sysadmin/audit/auth", authenticateToken, requireRole("SYSADMIN"), readLimiter, getAuthAuditLogs);
router.get("/sysadmin/audit/modifications", authenticateToken, requireRole("SYSADMIN"), readLimiter, getModificationAuditLogs);
router.get("/sysadmin/audit/security", authenticateToken, requireRole("SYSADMIN"), readLimiter, getSecurityAuditLogs);
router.get("/sysadmin/audit/system-activity", authenticateToken, requireRole("SYSADMIN"), readLimiter, getSystemActivityLogs);

// GoAccess Web Traffic Monitoring
router.get("/sysadmin/traffic/summary", authenticateToken, requireRole("SYSADMIN"), readLimiter, getTrafficSummaryHandler);
router.get("/sysadmin/traffic/report", readLimiter, getGoAccessHtmlReportHandler);

// DevOps Suite & IT Management Controls
router.get("/sysadmin/devops/telemetry", authenticateToken, requireRole("SYSADMIN"), readLimiter, getTelemetryHandler);
router.post("/sysadmin/devops/maintenance", authenticateToken, requireRole("SYSADMIN"), toggleMaintenanceHandler);
router.post("/sysadmin/devops/backup-db", authenticateToken, requireRole("SYSADMIN"), triggerBackupHandler);
router.get("/sysadmin/it-admins", authenticateToken, requireRole("SYSADMIN"), readLimiter, listItAdminsHandler);
router.post("/sysadmin/it-admins", authenticateToken, requireRole("SYSADMIN"), createItAdminHandler);

// Public maintenance status endpoint — no auth — polled by each portal
router.get("/maintenance/status", getPublicMaintenanceStatusHandler);

export default router;
