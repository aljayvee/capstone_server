import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import {
  authenticateToken,
  optionalAuthenticateToken,
  requireRole,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import {
  createFeedbackSchema,
  resolveFeedbackSchema,
} from "../validators/feedbackValidators.js";
import {
  submitFeedback,
  listFeedbacks,
  getFeedbackById,
  markFeedbackRead,
  resolveFeedback,
} from "../services/feedbackService.js";
import { logger } from "../lib/logger.js";
import type { FeedbackCategory, FeedbackStatus } from "@prisma/client";

const router = Router();

// Rate limit feedback submissions to prevent spam (10 per 15 minutes per IP)
const feedbackSubmissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many feedback submissions. Please try again later." },
});

// POST /api/feedback - Customer submits feedback (Authenticated or Guest)
router.post(
  "/",
  feedbackSubmissionLimiter,
  optionalAuthenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parseResult = createFeedbackSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: "Invalid feedback input.",
          details: parseResult.error.format(),
        });
      }

      // Check if logged-in user is a customer
      const customerId =
        req.user && String(req.user.role).toUpperCase() === "CUSTOMER"
          ? req.user.id
          : undefined;

      const created = await submitFeedback(parseResult.data, customerId);

      return res.status(201).json({
        message: "Thank you for your feedback! Our team has received your submission.",
        refCode: created.refCode,
        feedback: created,
      });
    } catch (error: any) {
      logger.error("[FeedbackRoutes] Error submitting feedback:", error);
      return res.status(500).json({ error: "Failed to submit feedback. Please try again." });
    }
  }
);

// GET /api/feedback - Staff list & search feedbacks
router.get(
  "/",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { status, category, search, limit, offset } = req.query;

      const result = await listFeedbacks({
        status: status ? (String(status) as FeedbackStatus) : undefined,
        category: category ? (String(category) as FeedbackCategory) : undefined,
        search: search ? String(search) : undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });

      return res.json(result);
    } catch (error: any) {
      logger.error("[FeedbackRoutes] Error listing feedbacks:", error);
      return res.status(500).json({ error: "Failed to load feedbacks." });
    }
  }
);

// GET /api/feedback/:id - Staff get single feedback details
router.get(
  "/:id",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid feedback ID." });

      const feedback = await getFeedbackById(id);
      if (!feedback) return res.status(404).json({ error: "Feedback not found." });

      return res.json({ feedback });
    } catch (error: any) {
      logger.error("[FeedbackRoutes] Error retrieving feedback:", error);
      return res.status(500).json({ error: "Failed to retrieve feedback." });
    }
  }
);

// PATCH /api/feedback/:id/read - Staff mark feedback as read/in review
router.patch(
  "/:id/read",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid feedback ID." });

      const updated = await markFeedbackRead(id, req.user!.id);
      return res.json({ message: "Feedback marked as read.", feedback: updated });
    } catch (error: any) {
      logger.error("[FeedbackRoutes] Error marking feedback read:", error);
      return res.status(500).json({ error: "Failed to update feedback status." });
    }
  }
);

// PATCH /api/feedback/:id/resolve - Staff mark feedback as resolved with developer notes
router.patch(
  "/:id/resolve",
  authenticateToken,
  requireRole(["OWNER", "DISPATCHER"]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid feedback ID." });

      const parseResult = resolveFeedbackSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: "Invalid resolution input.",
          details: parseResult.error.format(),
        });
      }

      const updated = await resolveFeedback(id, parseResult.data, req.user!.id);
      return res.json({ message: "Feedback successfully resolved.", feedback: updated });
    } catch (error: any) {
      logger.error("[FeedbackRoutes] Error resolving feedback:", error);
      return res.status(500).json({ error: "Failed to resolve feedback." });
    }
  }
);

export default router;
