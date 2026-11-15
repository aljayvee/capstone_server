import { Router } from "express";
import {
  createGroup,
  deleteGroup,
  getCatalog,
  getOwnPermissions,
  listAccounts,
  listGroups,
  updateAccountAccess,
  updateGroup,
} from "../controllers/accessController.js";
import {
  createSysAdminGroupHandler,
  deleteSysAdminGroupHandler,
  getSysAdminCatalogHandler,
  listSysAdminAccountsHandler,
  listSysAdminGroupsHandler,
  listSysAdminPmaAuditHandler,
  updateSysAdminAccountAccessHandler,
  updateSysAdminAccountStatusHandler,
  updateSysAdminGroupHandler,
} from "../controllers/sysAdminPmaController.js";
import { authenticateToken, requireMainOwner, requireRole } from "../middleware/auth.js";
import { readLimiter, userApiLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// Any Admin or dispatcher: what the portal may show this account.
router.get("/account/permissions", authenticateToken, requireRole(["OWNER", "DISPATCHER"]), readLimiter, getOwnPermissions);

// Access groups and per-account access: the Main Owner's alone (lib/mainOwner.ts).
const mainOwnerOnly = [authenticateToken, requireRole(["OWNER"]), requireMainOwner];

router.get("/access/catalog", ...mainOwnerOnly, readLimiter, getCatalog);
router.get("/access/groups", ...mainOwnerOnly, readLimiter, listGroups);
router.post("/access/groups", ...mainOwnerOnly, userApiLimiter, createGroup);
router.put("/access/groups/:id", ...mainOwnerOnly, userApiLimiter, updateGroup);
router.delete("/access/groups/:id", ...mainOwnerOnly, userApiLimiter, deleteGroup);
router.get("/access/accounts", ...mainOwnerOnly, readLimiter, listAccounts);
router.put("/access/accounts/:userId", ...mainOwnerOnly, userApiLimiter, updateAccountAccess);

// Dual-Governance SysAdmin PMA routes for the Main Owner (never touches regular staff).
router.get("/access/sysadmin/catalog", ...mainOwnerOnly, readLimiter, getSysAdminCatalogHandler);
router.get("/access/sysadmin/groups", ...mainOwnerOnly, readLimiter, listSysAdminGroupsHandler);
router.post("/access/sysadmin/groups", ...mainOwnerOnly, userApiLimiter, createSysAdminGroupHandler);
router.put("/access/sysadmin/groups/:id", ...mainOwnerOnly, userApiLimiter, updateSysAdminGroupHandler);
router.delete("/access/sysadmin/groups/:id", ...mainOwnerOnly, userApiLimiter, deleteSysAdminGroupHandler);
router.get("/access/sysadmin/accounts", ...mainOwnerOnly, readLimiter, listSysAdminAccountsHandler);
router.put("/access/sysadmin/accounts/:id", ...mainOwnerOnly, userApiLimiter, updateSysAdminAccountAccessHandler);
router.patch("/access/sysadmin/accounts/:id/status", ...mainOwnerOnly, userApiLimiter, updateSysAdminAccountStatusHandler);
router.get("/access/sysadmin/audit", ...mainOwnerOnly, readLimiter, listSysAdminPmaAuditHandler);

export default router;
