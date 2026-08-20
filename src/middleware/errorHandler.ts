import { NextFunction, Request, Response } from "express";
import { ServiceError } from "../services/ServiceError.js";
import { logger } from "../lib/logger.js";

// Centralized catch-all for errors forwarded via asyncHandler/next(err).
// ServiceError carries its own HTTP status; anything else is an unexpected
// failure and is logged + reported as a generic 500 (never leak internals).
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof ServiceError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
  }

  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  return res.status(500).json({ error: "Internal server error" });
}
