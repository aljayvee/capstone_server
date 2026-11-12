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

export default router;
