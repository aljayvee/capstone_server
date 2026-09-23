import { Router } from "express";
import {
  listErrands,
  getErrandById,
  listErrandsForUser,
  listErrandsForRider,
  createErrand,
  claimErrand,
  verifyErrand,
  releaseErrand,
  acceptErrand,
  assignRider,
  updateStatus,
  declineErrand,
  declineErrandReview,
  getDeclineReasons,
  setPinpoints,
  updateItems,
  markItemsPurchased,
  enablePayment,
  confirmOrder,
  quoteErrand,
  uploadProofImage,
  confirmProofImage,
  listProofImages,
  getProofImage,
} from "../controllers/errandController.js";
import { getPaymentSelection, confirmPaymentSelection } from "../controllers/paymentSelectionController.js";
import { getOpenExceptions, resolveException } from "../controllers/exceptionController.js";
import { uploadTrackBatch, getTrack } from "../controllers/trackingController.js";
import { getRating, submitRating } from "../controllers/ratingController.js";
import { submitSettlement } from "../controllers/settlementController.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { userApiLimiter, readLimiter, trackingLimiter } from "../middleware/rateLimiters.js";
import {
  getPaymentLedger,
  confirmUpfrontPayment,
  confirmTopUp,
  confirmBalancePayment,
  recordRefund,
  requestHalfPayment,
} from "../controllers/errandPaymentController.js";
import { uploadPaymentProof, getPaymentProof } from "../controllers/paymentProofController.js";

const router = Router();

// POST /api/errands/quote - Price a draft errand before it is created.
//
// Declared above the "/:id" routes below: Express matches in declaration order,
// and a future POST "/:id/..." handler placed first would capture "quote".
//
// A read in every sense that matters — it writes nothing — so it carries
// readLimiter rather than the stricter write budget. The customer's checkout
// re-quotes as they adjust their basket.
router.post("/quote", authenticateToken, readLimiter, quoteErrand);

// --- Reconciliation exceptions ------------------------------------------------
//
// Declared above "/:id" so the literal path is matched before the id pattern
// captures "exceptions" as an errand id.

// GET /api/errands/exceptions - the dispatcher's open queue. Staff only: this
// aggregates evidence across every customer's errands.
router.get(
  "/exceptions",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  readLimiter,
  getOpenExceptions
);

// POST /api/errands/:id/exceptions/resolve - record that a person cleared one.
// A dispatcher clears operational exceptions; an owner may clear anything,
// including one a dispatcher already closed, which adds a second row rather
// than replacing the first.
router.post(
  "/:id/exceptions/resolve",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  resolveException
);

// GET /api/errands - Fetch all errands (Owner/Dispatcher view)
router.get("/", authenticateToken, requireRole(["OWNER", "DISPATCHER"]), readLimiter, listErrands);

// --- Photographic proof (receipts, transfers, delivery) ---------------------
//
// Rider-only writes: the person who took the photo is the person who owns the
// errand. Reads are open to any signed-in role because dispatch and the owner
// both need to see the evidence during a dispute.
//
// userApiLimiter rather than readLimiter on the upload: it carries a ~400KB body
// and spends a paid OCR call, so it belongs on the write budget.

// POST /api/errands/:id/proof-images - upload a photo, OCR it, return the reading
router.post(
  "/:id/proof-images",
  authenticateToken,
  requireRole(["RIDER"]),
  userApiLimiter,
  uploadProofImage
);

// PATCH /api/errands/:id/proof-images/:imageId/confirm - rider accepts or corrects
router.patch(
  "/:id/proof-images/:imageId/confirm",
  authenticateToken,
  requireRole(["RIDER"]),
  userApiLimiter,
  confirmProofImage
);

// GET /api/errands/:id/proof-images - metadata only, never the image blobs.
// Object-level check inside: staff see any errand, a customer only their own, a
// rider only errands assigned to them.
router.get("/:id/proof-images", authenticateToken, readLimiter, listProofImages);

// GET /api/errands/:id/proof-images/:imageId - one image's bytes, same check.
// Separate from the list because the list omits every blob on purpose.
router.get("/:id/proof-images/:imageId", authenticateToken, readLimiter, getProofImage);

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

// PATCH /api/errands/:id/verify - the dispatcher has checked the items with the
// customer and is taking the order on. Distinct from the claim above, which now
// happens the moment they OPEN the request so that only one dispatcher is ever
// in a customer's chat. Steps 1-4 stay shut until this stamps verifiedAt.
router.patch(
  "/:id/verify",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  verifyErrand
);

// PATCH /api/errands/:id/release - hands a request the dispatcher opened but did
// not take back to the queue. Refused once verified: at that point the customer
// has been told who their dispatcher is, and declining is the honest exit.
router.patch(
  "/:id/release",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  releaseErrand
);

// POST /api/errands/:id/accept - Rider accepts an errand assigned to them
router.post("/:id/accept", authenticateToken, requireRole(["RIDER"]), userApiLimiter, acceptErrand);

// POST /api/errands/:id/decline - Rider declines an errand assigned to them
// (un-assigns, reverts to PENDING so the dispatcher can reassign)
router.post("/:id/decline", authenticateToken, requireRole(["RIDER"]), userApiLimiter, declineErrand);

// PATCH /api/errands/:id/dispatcher-decline - dispatcher declines during review,
// recording why. The reason is required by the validator: this endpoint exists
// precisely because the old path let it be dropped.
router.patch(
  "/:id/dispatcher-decline",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  declineErrandReview
);

// GET /api/errands/:id/decline-reasons - visible to staff and to the customer
// who owns the errand (enforced by the same object-level check as GET /:id).
router.get("/:id/decline-reasons", authenticateToken, readLimiter, getDeclineReasons);

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

// ── the 50% downpayment plan ─────────────────────────────────────────────
//
// Money arrives on the company Facebook Page, outside this system, so every
// write here records a PERSON attesting they saw it — hence OWNER/DISPATCHER
// only. A rider must never be able to mark a customer's payment received: they
// are the party standing to benefit from the goods being released.
//
// The read is open to anyone with a stake in the errand (ownership checked in
// the controller): the customer needs to see what they owe, the rider needs the
// figure to collect at the door.

// ── the customer's own payment screenshot ────────────────────────────────
//
// Read by Cloud Vision and checked against the errand before it is stored: it
// must carry a reference number, be for the amount owed, and be dated today.
// For the mid-way half-payment a receipt that passes confirms it on its own
// (see paymentProofService.settleAutomatically); a reused reference number and
// the balance still wait for a dispatcher.

// POST /api/errands/:id/payments/request-half - the rider, holding every item,
// asks for the customer's 50% before heading to them. The one payment write a
// rider may make: it records nothing as paid, it only asks.
router.post(
  "/:id/payments/request-half",
  authenticateToken,
  requireRole(["RIDER"]),
  userApiLimiter,
  requestHalfPayment
);

// POST /api/errands/:id/payment-proof - customer uploads their confirmation
router.post(
  "/:id/payment-proof",
  authenticateToken,
  requireRole(["CUSTOMER"]),
  userApiLimiter,
  uploadPaymentProof
);

// GET /api/errands/:id/payment-proof - what was read from it
router.get("/:id/payment-proof", authenticateToken, readLimiter, getPaymentProof);

// GET /api/errands/:id/payments - ledger, amount paid, balance due, plan state
router.get("/:id/payments", authenticateToken, readLimiter, getPaymentLedger);

// POST /api/errands/:id/payments/upfront - dispatcher confirms what was owed
// before dispatch: half the goods on the 50% plan, the whole bill on GCash /
// Bank Transfer / Card.
router.post(
  "/:id/payments/upfront",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  confirmUpfrontPayment
);

// POST /api/errands/:id/payments/top-up - dispatcher confirms the customer covered
// a receipt that came in higher than they agreed to. Clears the goods-release hold.
router.post(
  "/:id/payments/top-up",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  confirmTopUp
);

// POST /api/errands/:id/payments/balance - dispatcher confirms the customer
// paid the remaining balance electronically (GCash / Bank Transfer), instead
// of the rider collecting it in cash at the door.
router.post(
  "/:id/payments/balance",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  confirmBalancePayment
);

// POST /api/errands/:id/payments/refund - money back, e.g. cancelled after downpayment
router.post(
  "/:id/payments/refund",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  userApiLimiter,
  recordRefund
);

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
