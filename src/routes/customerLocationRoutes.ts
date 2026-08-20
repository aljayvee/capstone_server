import { Router } from "express";
import {
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
} from "../controllers/customerLocationController.js";
import { authenticateToken } from "../middleware/auth.js";
import { userApiLimiter, readLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// GET /api/customer-locations/:userId
router.get("/:userId", authenticateToken, readLimiter, listLocations);

// POST /api/customer-locations
router.post("/", authenticateToken, userApiLimiter, createLocation);

// PUT /api/customer-locations/:id
router.put("/:id", authenticateToken, userApiLimiter, updateLocation);

// DELETE /api/customer-locations/:id
router.delete("/:id", authenticateToken, deleteLocation);

export default router;
