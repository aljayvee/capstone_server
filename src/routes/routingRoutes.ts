import { Router } from "express";
import { getDirections } from "../controllers/routingController.js";
import { authenticateToken } from "../middleware/auth.js";
import rateLimit from "express-rate-limit";

const router = Router();

const routingLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 requests per `window` (here, per minute)
  message: { message: "Too many routing requests from this IP, please try again after a minute" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/directions", authenticateToken, routingLimiter, getDirections);

export default router;
