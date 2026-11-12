import { Router } from "express";
import { listUsers, getUserPresence, createUser, updateUser, updateProfile, changePassword } from "../controllers/userController.js";
import { authenticateToken, requireRole, requirePermission } from "../middleware/auth.js";
import { userApiLimiter, readLimiter } from "../middleware/rateLimiters.js";

const router = Router();

router.get("/presence", authenticateToken, readLimiter, getUserPresence);
router.get("/", authenticateToken, requireRole(["OWNER"]), requirePermission("users.view"), readLimiter, listUsers);
router.post("/", authenticateToken, requireRole(["OWNER"]), requirePermission("users.manage"), userApiLimiter, createUser);
// Staff and riders only: these ids are `users` rows, and customers are numbered
// separately, so customer 9 passed the controllers' "your own id" check for
// dispatcher 9's profile and password (2026-10-07).
const STAFF_AND_RIDERS = ["OWNER", "DISPATCHER", "RIDER"];
router.put("/profile/:userId", authenticateToken, requireRole(STAFF_AND_RIDERS), updateProfile);
router.put("/password/:userId", authenticateToken, requireRole(STAFF_AND_RIDERS), userApiLimiter, changePassword);
router.put("/:id", authenticateToken, requireRole(["OWNER"]), requirePermission("users.manage"), userApiLimiter, updateUser);

export default router;
