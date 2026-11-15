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
  getReportPrintLogs,
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
  getDispatcherAiSuggestionsHandler,
  toggleDispatcherAiSuggestionsHandler,
  getKuyaSugoHandler,
  toggleKuyaSugoHandler,
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
import {
  getPublicReleasesHandler,
  getSysAdminReleasesHandler,
  updateReleaseDetailsHandler,
  uploadApkHandler,
  uploadChunkHandler,
  finalizeChunkedUploadHandler,
  cancelChunkedUploadHandler,
  downloadApkHandler,
  downloadApkChunkHandler,
} from "../controllers/appReleaseController.js";
import { authenticateToken, requireMainSysAdmin, requireRole, requireSysAdminPermission } from "../middleware/auth.js";
import { verificationLimiter, readLimiter } from "../middleware/rateLimiters.js";
import {
  createSysAdminGroupHandler,
  deleteSysAdminGroupHandler,
  getMySysAdminPermissionsHandler,
  getSysAdminCatalogHandler,
  listSysAdminAccountsHandler,
  listSysAdminGroupsHandler,
  listSysAdminPmaAuditHandler,
  updateSysAdminAccountAccessHandler,
  updateSysAdminAccountStatusHandler,
  updateSysAdminGroupHandler,
} from "../controllers/sysAdminPmaController.js";
import {
  listIncidentsHandler,
  getIncidentHandler,
  createIncidentHandler,
  updateIncidentHandler,
} from "../controllers/sysAdminIncidentController.js";
import { getOffsiteStatusHandler, startRestoreCheckHandler } from "../controllers/backupOffsiteController.js";
import { getIntegrationReportHandler } from "../controllers/integrationCheckController.js";
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
router.get("/sysadmin/users", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("users.view"), readLimiter, getMonitoredAccounts);
router.get("/sysadmin/users/:role/:id/sessions", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("users.view"), readLimiter, getSessionsForAccount);
router.post("/sysadmin/users/sessions/:sessionId/terminate", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("users.sessions"), sysAdminMutationLimiter, terminateSession);
router.patch("/sysadmin/users/:role/:id/status", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("users.status"), sysAdminMutationLimiter, verifyStepUpPassword, updateAccountStatusHandler);

// ── Categorized Audit Logs Center ────────────────────────────────────────────
router.get("/sysadmin/audit/auth", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("audit.view"), readLimiter, getAuthAuditLogs);
router.get("/sysadmin/audit/modifications", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("audit.view"), readLimiter, getModificationAuditLogs);
router.get("/sysadmin/audit/security", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("audit.view"), readLimiter, getSecurityAuditLogs);
router.get("/sysadmin/audit/system-activity", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("audit.view"), readLimiter, getSystemActivityLogs);
router.get("/sysadmin/audit/report-prints", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("audit.view"), readLimiter, getReportPrintLogs);

// ── GoAccess Web Traffic Monitoring ──────────────────────────────────────────
router.get("/sysadmin/traffic/summary", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("traffic.view"), readLimiter, getTrafficSummaryHandler);
router.get("/sysadmin/traffic/report", readLimiter, getGoAccessHtmlReportHandler);

// ── DevOps Suite & IT Management Controls ────────────────────────────────────
router.get("/sysadmin/devops/telemetry", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("telemetry.view"), readLimiter, getTelemetryHandler);
router.post("/sysadmin/devops/maintenance", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.services"), sysAdminMaintenanceLimiter, verifyStepUpPassword, toggleMaintenanceHandler);
router.post("/sysadmin/devops/backup-db", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.backups.manage"), sysAdminBackupLimiter, verifyStepUpPassword, triggerBackupHandler);
router.get("/sysadmin/it-admins", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("staff.view"), readLimiter, listItAdminsHandler);
router.post("/sysadmin/it-admins", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("staff.manage"), sysAdminMutationLimiter, verifyStepUpPassword, createItAdminHandler);

// ── SysAdmin Permission Management & Access (PMA) ────────────────────────────
router.get("/sysadmin/pma/me", authenticateToken, requireRole("SYSADMIN"), readLimiter, getMySysAdminPermissionsHandler);
router.get("/sysadmin/pma/catalog", authenticateToken, requireRole("SYSADMIN"), requireMainSysAdmin, readLimiter, getSysAdminCatalogHandler);
router.get("/sysadmin/pma/groups", authenticateToken, requireRole("SYSADMIN"), requireMainSysAdmin, readLimiter, listSysAdminGroupsHandler);
router.post("/sysadmin/pma/groups", authenticateToken, requireRole("SYSADMIN"), requireMainSysAdmin, sysAdminMutationLimiter, verifyStepUpPassword, createSysAdminGroupHandler);
router.put("/sysadmin/pma/groups/:id", authenticateToken, requireRole("SYSADMIN"), requireMainSysAdmin, sysAdminMutationLimiter, verifyStepUpPassword, updateSysAdminGroupHandler);
router.delete("/sysadmin/pma/groups/:id", authenticateToken, requireRole("SYSADMIN"), requireMainSysAdmin, sysAdminMutationLimiter, verifyStepUpPassword, deleteSysAdminGroupHandler);
router.get("/sysadmin/pma/accounts", authenticateToken, requireRole("SYSADMIN"), requireMainSysAdmin, readLimiter, listSysAdminAccountsHandler);
router.put("/sysadmin/pma/accounts/:id", authenticateToken, requireRole("SYSADMIN"), requireMainSysAdmin, sysAdminMutationLimiter, verifyStepUpPassword, updateSysAdminAccountAccessHandler);
router.patch("/sysadmin/pma/accounts/:id/status", authenticateToken, requireRole("SYSADMIN"), requireMainSysAdmin, sysAdminMutationLimiter, verifyStepUpPassword, updateSysAdminAccountStatusHandler);
router.get("/sysadmin/pma/audit", authenticateToken, requireRole("SYSADMIN"), requireMainSysAdmin, readLimiter, listSysAdminPmaAuditHandler);

// Phase 2: Programmatic Service Controls, Backups Inventory, Log Streaming & Alerts
router.post("/sysadmin/devops/services/:service/restart", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.services"), sysAdminMutationLimiter, verifyStepUpPassword, restartServiceHandler);
router.get("/sysadmin/devops/backups", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.backups.view"), readLimiter, listBackupsHandler);
router.get("/sysadmin/devops/backups/:id/download", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.backups.manage"), downloadBackupHandler);
// Off-site copies in R2 and restore tests (2026-11-15).
router.get("/sysadmin/devops/backups/offsite", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.backups.view"), readLimiter, getOffsiteStatusHandler);
router.post("/sysadmin/devops/backups/restore-check", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.backups.manage"), sysAdminBackupLimiter, verifyStepUpPassword, startRestoreCheckHandler);
router.delete("/sysadmin/devops/backups/:id", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.backups.manage"), sysAdminMutationLimiter, verifyStepUpPassword, deleteBackupHandler);
router.get("/sysadmin/devops/logs", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("logs.view"), readLimiter, getLogsHandler);
router.get("/sysadmin/devops/alerts/status", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("telemetry.view"), readLimiter, getAlertStatusHandler);
router.get("/sysadmin/devops/integrations", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("telemetry.view"), readLimiter, getIntegrationReportHandler);
router.post("/sysadmin/devops/alerts/test", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.services"), sysAdminMutationLimiter, sendTestAlertHandler);
// Incident records (2026-11-15): opened by the health watch or by hand; resolving needs cause and fix.
router.get("/sysadmin/devops/incidents", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("incidents.view"), readLimiter, listIncidentsHandler);
router.get("/sysadmin/devops/incidents/:id", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("incidents.view"), readLimiter, getIncidentHandler);
router.post("/sysadmin/devops/incidents", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("incidents.manage"), sysAdminMutationLimiter, createIncidentHandler);
router.patch("/sysadmin/devops/incidents/:id", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("incidents.manage"), sysAdminMutationLimiter, updateIncidentHandler);
router.post("/sysadmin/devops/server-error", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.features"), sysAdminMutationLimiter, toggleServerErrorHandler);
router.post("/sysadmin/devops/dispatcher-ai-suggestions", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.features"), sysAdminMutationLimiter, toggleDispatcherAiSuggestionsHandler);
router.post("/sysadmin/devops/kuya-sugo", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("devops.features"), sysAdminMutationLimiter, toggleKuyaSugoHandler);

// ── Security Threat Center & IP Defense (Dual-Tier) ──────────────────────────
router.get("/sysadmin/threats/overview", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("threats.view"), readLimiter, getThreatOverviewHandler);
router.get("/sysadmin/threats/blocklist", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("threats.view"), readLimiter, getBlockedIpsHandler);
router.post("/sysadmin/threats/blocklist", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("threats.manage"), sysAdminMutationLimiter, verifyStepUpPassword, manuallyBlockIpHandler);
router.delete("/sysadmin/threats/blocklist/:id", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("threats.manage"), sysAdminMutationLimiter, verifyStepUpPassword, unblockIpHandler);
router.get("/sysadmin/threats/whitelist", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("threats.view"), readLimiter, getWhitelistedIpsHandler);
router.post("/sysadmin/threats/whitelist", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("threats.manage"), sysAdminMutationLimiter, addWhitelistedIpHandler);
router.delete("/sysadmin/threats/whitelist/:id", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("threats.manage"), sysAdminMutationLimiter, removeWhitelistedIpHandler);

// ── Public Maintenance Status Endpoint (Polled by portals, unauthenticated) ──
router.get("/maintenance/status", getPublicMaintenanceStatusHandler);

// ── Public Server Error Status Endpoint (Polled by login screen, unauthenticated) ──
router.get("/system/server-error-status", getServerErrorStatusHandler);

// ── Dispatcher AI Suggestions Status (Read by the dispatcher portal) ─────────
router.get("/system/dispatcher-ai-suggestions", authenticateToken, requireRole(["OWNER", "DISPATCHER"]), readLimiter, getDispatcherAiSuggestionsHandler);

// ── Kuya Sugo Status (Read by the owner portal to show/hide the copilot) ────
router.get("/system/kuya-sugo", authenticateToken, requireRole(["OWNER", "SYSADMIN"]), readLimiter, getKuyaSugoHandler);

// ── App Releases & APK Deployment (Sugo Express & Sugo Rider) ────────────────
router.get("/sysadmin/app-releases", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("releases.view"), readLimiter, getSysAdminReleasesHandler);
router.put("/sysadmin/app-releases/:target", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("releases.manage"), sysAdminMutationLimiter, updateReleaseDetailsHandler);
router.post("/sysadmin/app-releases/upload/:target", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("releases.manage"), uploadApkHandler);
router.post("/sysadmin/app-releases/upload-chunk/:target", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("releases.manage"), uploadChunkHandler);
router.post("/sysadmin/app-releases/finalize-upload/:target", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("releases.manage"), finalizeChunkedUploadHandler);
router.post("/sysadmin/app-releases/cancel-upload/:target", authenticateToken, requireRole("SYSADMIN"), requireSysAdminPermission("releases.manage"), cancelChunkedUploadHandler);

// ── Public App Releases (Landing Page & Mobile Update Feed) ──────────────────
router.get("/app-releases/public", getPublicReleasesHandler);
router.get("/app-releases/download/:target", downloadApkHandler);
router.get("/app-releases/download-chunk/:target", downloadApkChunkHandler);

export default router;
