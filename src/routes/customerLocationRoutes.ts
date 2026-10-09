import { Router } from "express";
import {
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
} from "../controllers/customerLocationController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { userApiLimiter, readLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// GET /api/customer-locations/:userId
router.get("/:userId", authenticateToken, readLimiter, listLocations);

// Writes are the customer's own, so CUSTOMER only: the controllers compare ids,
// and dispatcher 9 or rider 9 carries the same number as customer 9.

// POST /api/customer-locations
router.post("/", authenticateToken, requireRole(["CUSTOMER"]), userApiLimiter, createLocation);

// PUT /api/customer-locations/:id
router.put("/:id", authenticateToken, requireRole(["CUSTOMER"]), userApiLimiter, updateLocation);

// DELETE /api/customer-locations/:id
router.delete("/:id", authenticateToken, requireRole(["CUSTOMER"]), deleteLocation);

export default router;
