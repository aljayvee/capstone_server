import { Router } from "express";
import { listUsers, createUser, updateUser, updateProfile } from "../controllers/userController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { userApiLimiter, readLimiter } from "../middleware/rateLimiters.js";

const router = Router();

router.get("/", authenticateToken, requireRole(["OWNER"]), readLimiter, listUsers);
router.post("/", authenticateToken, requireRole(["OWNER"]), userApiLimiter, createUser);
router.put("/profile/:userId", authenticateToken, updateProfile);
router.put("/:id", authenticateToken, requireRole(["OWNER"]), userApiLimiter, updateUser);

export default router;
