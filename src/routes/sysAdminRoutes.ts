import { Router } from "express";
import {
  sysAdminLogin,
  sysAdminCompleteProfile,
  sysAdminVerifyMagicLink,
  sysAdminResendMagicLink,
  sysAdminMe,
  sysAdminLogout,
  sysAdminVerify2FaHandler,
  sysAdminResend2FaHandler,
  sysAdminUnlockAccountHandler,
  sysAdminRefreshHandler,
  sysAdminToggle2FaHandler,
  sysAdminGetTrustedDevicesHandler,
  sysAdminRevokeTrustedDeviceHandler,
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
  restartServiceHandler,
  listBackupsHandler,
  downloadBackupHandler,
  deleteBackupHandler,
  getLogsHandler,
  getAlertStatusHandler,
  sendTestAlertHandler,
  getServerErrorStatusHandler,
  toggleServerErrorHandler,
} from "../controllers/sysAdminDevOpsController.js";
import {
  requestProfileOtpHandler,
  verifyProfileOtpHandler,
  updateProfileHandler,
} from "../controllers/sysAdminProfileController.js";
import {
  getThreatOverviewHandler,
  getBlockedIpsHandler,
  manuallyBlockIpHandler,
  unblockIpHandler,
  getWhitelistedIpsHandler,
  addWhitelistedIpHandler,
  removeWhitelistedIpHandler,
} from "../controllers/sysAdminThreatController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { verificationLimiter, readLimiter } from "../middleware/rateLimiters.js";
import {
  sysAdminLoginLimiter,
  sysAdminBackupLimiter,
  sysAdminMaintenanceLimiter,
  sysAdminMutationLimiter,
  verifySysAdminCsrf,
  setSysAdminSecurityHeaders,
  blockTorAndProxies,
  verifyStepUpPassword,
} from "../middleware/sysAdminSecurity.js";

const router = Router();

// Apply hardened security headers and Tor/proxy defenses across all SysAdmin endpoints
router.use("/sysadmin", setSysAdminSecurityHeaders, blockTorAndProxies);

// Apply CSRF and origin defense on mutating routes under /sysadmin
router.use("/sysadmin", verifySysAdminCsrf);

// ── SysAdmin Authentication & First-Login Setup Wizard ───────────────────────
router.post("/sysadmin/auth/login", sysAdminLoginLimiter, sysAdminLogin);
router.post("/sysadmin/auth/verify-2fa", verificationLimiter, sysAdminVerify2FaHandler);
router.post("/sysadmin/auth/resend-2fa", verificationLimiter, sysAdminResend2FaHandler);
router.get("/sysadmin/auth/unlock-account", sysAdminUnlockAccountHandler);
router.post("/sysadmin/auth/unlock-account", sysAdminUnlockAccountHandler);
router.post("/sysadmin/auth/refresh", sysAdminRefreshHandler);

router.post("/sysadmin/auth/complete-profile", verificationLimiter, sysAdminCompleteProfile);
router.get("/sysadmin/auth/verify-email", verificationLimiter, sysAdminVerifyMagicLink);
router.post("/sysadmin/auth/verify-email", verificationLimiter, sysAdminVerifyMagicLink);
router.post("/sysadmin/auth/resend-verification", verificationLimiter, sysAdminResendMagicLink);
router.post("/sysadmin/auth/logout", authenticateToken, requireRole("SYSADMIN"), sysAdminLogout);
router.get("/sysadmin/auth/me", authenticateToken, requireRole("SYSADMIN"), sysAdminMe);

// ── Security Policies & Trusted Device Controls ──────────────────────────────
router.post("/sysadmin/auth/2fa-policy", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, sysAdminToggle2FaHandler);
router.get("/sysadmin/auth/trusted-devices", authenticateToken, requireRole("SYSADMIN"), readLimiter, sysAdminGetTrustedDevicesHandler);
router.delete("/sysadmin/auth/trusted-devices/:deviceId", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, sysAdminRevokeTrustedDeviceHandler);

// ── Profile Change Security Gate (3-layer: password + CONFIRM + email OTP) ────
router.post("/sysadmin/auth/request-profile-otp", authenticateToken, requireRole("SYSADMIN"), verificationLimiter, requestProfileOtpHandler);
router.post("/sysadmin/auth/verify-profile-otp", authenticateToken, requireRole("SYSADMIN"), verificationLimiter, verifyProfileOtpHandler);
router.patch("/sysadmin/auth/update-profile", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, updateProfileHandler);

// ── Multi-Role User Account Monitoring & Security Actions ────────────────────
router.get("/sysadmin/users", authenticateToken, requireRole("SYSADMIN"), readLimiter, getMonitoredAccounts);
router.get("/sysadmin/users/:role/:id/sessions", authenticateToken, requireRole("SYSADMIN"), readLimiter, getSessionsForAccount);
router.post("/sysadmin/users/sessions/:sessionId/terminate", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, terminateSession);
router.patch("/sysadmin/users/:role/:id/status", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, verifyStepUpPassword, updateAccountStatusHandler);

// ── Categorized Audit Logs Center ────────────────────────────────────────────
router.get("/sysadmin/audit/auth", authenticateToken, requireRole("SYSADMIN"), readLimiter, getAuthAuditLogs);
router.get("/sysadmin/audit/modifications", authenticateToken, requireRole("SYSADMIN"), readLimiter, getModificationAuditLogs);
router.get("/sysadmin/audit/security", authenticateToken, requireRole("SYSADMIN"), readLimiter, getSecurityAuditLogs);
router.get("/sysadmin/audit/system-activity", authenticateToken, requireRole("SYSADMIN"), readLimiter, getSystemActivityLogs);

// ── GoAccess Web Traffic Monitoring ──────────────────────────────────────────
router.get("/sysadmin/traffic/summary", authenticateToken, requireRole("SYSADMIN"), readLimiter, getTrafficSummaryHandler);
router.get("/sysadmin/traffic/report", readLimiter, getGoAccessHtmlReportHandler);

// ── DevOps Suite & IT Management Controls ────────────────────────────────────
router.get("/sysadmin/devops/telemetry", authenticateToken, requireRole("SYSADMIN"), readLimiter, getTelemetryHandler);
router.post("/sysadmin/devops/maintenance", authenticateToken, requireRole("SYSADMIN"), sysAdminMaintenanceLimiter, verifyStepUpPassword, toggleMaintenanceHandler);
router.post("/sysadmin/devops/backup-db", authenticateToken, requireRole("SYSADMIN"), sysAdminBackupLimiter, verifyStepUpPassword, triggerBackupHandler);
router.get("/sysadmin/it-admins", authenticateToken, requireRole("SYSADMIN"), readLimiter, listItAdminsHandler);
router.post("/sysadmin/it-admins", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, verifyStepUpPassword, createItAdminHandler);

// Phase 2: Programmatic Service Controls, Backups Inventory, Log Streaming & Alerts
router.post("/sysadmin/devops/services/:service/restart", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, verifyStepUpPassword, restartServiceHandler);
router.get("/sysadmin/devops/backups", authenticateToken, requireRole("SYSADMIN"), readLimiter, listBackupsHandler);
router.get("/sysadmin/devops/backups/:id/download", authenticateToken, requireRole("SYSADMIN"), downloadBackupHandler);
router.delete("/sysadmin/devops/backups/:id", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, verifyStepUpPassword, deleteBackupHandler);
router.get("/sysadmin/devops/logs", authenticateToken, requireRole("SYSADMIN"), readLimiter, getLogsHandler);
router.get("/sysadmin/devops/alerts/status", authenticateToken, requireRole("SYSADMIN"), readLimiter, getAlertStatusHandler);
router.post("/sysadmin/devops/alerts/test", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, sendTestAlertHandler);
router.post("/sysadmin/devops/server-error", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, toggleServerErrorHandler);

// ── Security Threat Center & IP Defense (Dual-Tier) ──────────────────────────
router.get("/sysadmin/threats/overview", authenticateToken, requireRole("SYSADMIN"), readLimiter, getThreatOverviewHandler);
router.get("/sysadmin/threats/blocklist", authenticateToken, requireRole("SYSADMIN"), readLimiter, getBlockedIpsHandler);
router.post("/sysadmin/threats/blocklist", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, verifyStepUpPassword, manuallyBlockIpHandler);
router.delete("/sysadmin/threats/blocklist/:id", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, verifyStepUpPassword, unblockIpHandler);
router.get("/sysadmin/threats/whitelist", authenticateToken, requireRole("SYSADMIN"), readLimiter, getWhitelistedIpsHandler);
router.post("/sysadmin/threats/whitelist", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, addWhitelistedIpHandler);
router.delete("/sysadmin/threats/whitelist/:id", authenticateToken, requireRole("SYSADMIN"), sysAdminMutationLimiter, removeWhitelistedIpHandler);

// ── Public Maintenance Status Endpoint (Polled by portals, unauthenticated) ──
router.get("/maintenance/status", getPublicMaintenanceStatusHandler);

// ── Public Server Error Status Endpoint (Polled by login screen, unauthenticated) ──
router.get("/system/server-error-status", getServerErrorStatusHandler);

export default router;
