import { Router } from "express";
import {
  listErrands,
  getErrandById,
  listErrandsForUser,
  listErrandsForRider,
  createErrand,
  claimErrand,
  acceptErrand,
  assignRider,
  updateStatus,
  declineErrand,
  setPinpoints,
  updateItems,
  markItemsPurchased,
  enablePayment,
  confirmOrder,
} from "../controllers/errandController.js";
import { getPaymentSelection, confirmPaymentSelection } from "../controllers/paymentSelectionController.js";
import { uploadTrackBatch, getTrack } from "../controllers/trackingController.js";
import { getRating, submitRating } from "../controllers/ratingController.js";
import { submitSettlement } from "../controllers/settlementController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { userApiLimiter, readLimiter, trackingLimiter } from "../middleware/rateLimiters.js";

const router = Router();

// GET /api/errands - Fetch all errands (Owner/Dispatcher view)
router.get("/", authenticateToken, requireRole(["OWNER", "DISPATCHER"]), readLimiter, listErrands);

// GET /api/errands/:id - Fetch single errand details by ID
router.get("/:id", authenticateToken, readLimiter, getErrandById);

// GET /api/errands/user/:userId - Fetch active errands for a specific customer
router.get("/user/:userId", authenticateToken, readLimiter, listErrandsForUser);

// GET /api/errands/rider/:riderId - Fetch errands assigned to a specific rider
router.get("/rider/:riderId", authenticateToken, readLimiter, listErrandsForRider);

// POST /api/errands - Create a new 3NF errand (Customer App)
router.post("/", authenticateToken, userApiLimiter, createErrand);

// PATCH /api/errands/:id/claim - Claim an errand (Dispatcher)
router.patch("/:id/claim", authenticateToken, requireRole(["OWNER", "DISPATCHER"]), claimErrand);

// POST /api/errands/:id/accept - Rider accepts an errand assigned to them
router.post("/:id/accept", authenticateToken, requireRole(["RIDER"]), userApiLimiter, acceptErrand);

// POST /api/errands/:id/decline - Rider declines an errand assigned to them
// (un-assigns, reverts to PENDING so the dispatcher can reassign)
router.post("/:id/decline", authenticateToken, requireRole(["RIDER"]), userApiLimiter, declineErrand);

// POST /api/errands/:id/pinpoints - Dispatcher sets/replaces store pinpoints (max 3)
router.post(
  "/:id/pinpoints",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  setPinpoints
);

// PATCH /api/errands/:id/items - Dispatcher corrects the working item list
// (PabiliDetail) post-creation. See PabiliItemRequest for the untouched
// original the customer submitted.
router.patch(
  "/:id/items",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  updateItems
);

// PATCH /api/errands/:id/items-purchased - Rider marks the item list as bought.
// Customer-facing progress-stepper gate (see itemsPurchasedAt on Errand).
router.patch(
  "/:id/items-purchased",
  authenticateToken,
  requireRole(["RIDER"]),
  userApiLimiter,
  markItemsPurchased
);

// POST /api/errands/:id/enable-payment - Dispatcher unlocks the chat-embedded
// payment-mode selection flow for the customer (see PaymentSelection gate)
router.post(
  "/:id/enable-payment",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  enablePayment
);

// POST /api/errands/:id/assign-rider - Assign Rider to Errand
router.post(
  "/:id/assign-rider",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  assignRider
);

// PATCH /api/errands/:id/status - Update errand status
router.patch(
  "/:id/status",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER", "RIDER"]),
  userApiLimiter,
  updateStatus
);

// GET /api/errands/:id/payment-selection - Current confirmed payment mode, if any
router.get("/:id/payment-selection", authenticateToken, readLimiter, getPaymentSelection);

// POST /api/errands/:id/payment-selection - Customer's CONFIRMED payment mode
// choice (the terminal step of the chat-embedded selection flow — see
// PaymentModeSelectionModal.tsx in CustomerApp). Ownership + duplicate +
// mode-availability checks all live in paymentSelectionService.ts.
router.post("/:id/payment-selection", authenticateToken, userApiLimiter, confirmPaymentSelection);

// GET /api/errands/:id/rating - Existing rating for this errand, if any
router.get("/:id/rating", authenticateToken, readLimiter, getRating);

// POST /api/errands/:id/rating - Customer rates the rider after delivery
router.post("/:id/rating", authenticateToken, userApiLimiter, submitRating);

// POST /api/errands/:id/confirm-order - Customer confirms itemized store-grouped breakdown
router.post("/:id/confirm-order", authenticateToken, userApiLimiter, confirmOrder);

// POST /api/errands/:id/settle - Rider reconciles cash collected against the
// expected total (COD errands only — see settlementService.ts's guard)
router.post("/:id/settle", authenticateToken, requireRole(["RIDER"]), userApiLimiter, submitSettlement);

// POST /api/errands/:id/track - rider uploads a batch of GPS breadcrumb points,
// including any buffered during a signal blackout. This is the durable trail
// behind ETA learning, dispute replay, and proximity dispatch - live map pins
// still stream through Firebase RTDB (see AGENTS.md section 7).
router.post(
  "/:id/track",
  authenticateToken,
  requireRole(["RIDER"]),
  trackingLimiter,
  uploadTrackBatch
);

// GET /api/errands/:id/track - breadcrumb replay. Staff only: a rider's
// movement history is more sensitive than the errand record itself.
router.get(
  "/:id/track",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  readLimiter,
  getTrack
);

export default router;
