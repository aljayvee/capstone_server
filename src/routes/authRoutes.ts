import { Router } from "express";
import { login, riderLogin, refresh, logout } from "../controllers/authController.js";
import { authenticateToken } from "../middleware/auth.js";
import { loginLimiter } from "../middleware/rateLimiters.js";

const router = Router();

router.post("/auth/login", loginLimiter, login);
router.post("/riders/login", loginLimiter, riderLogin);
router.post("/auth/refresh", refresh);
router.post("/auth/logout", authenticateToken, logout);

export default router;
