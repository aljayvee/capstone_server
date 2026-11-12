import { Router } from "express";
import { getDirections, getRiderRoute } from "../controllers/routingController.js";
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

// Reading a line already calculated costs no routing-engine request, and a
// tracking map asks again on every notice plus a slow safety poll, so this is
// looser than the limiter above. Several customers can share one carrier IP.
const riderRouteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  message: { error: "Too many route requests from this connection. Please try again in a minute." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/directions", authenticateToken, routingLimiter, getDirections);
router.get("/rider-route", authenticateToken, riderRouteLimiter, getRiderRoute);

export default router;
