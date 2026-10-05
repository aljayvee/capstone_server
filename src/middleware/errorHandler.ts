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

  const isServiceError =
    err instanceof ServiceError ||
    (err instanceof Error && err.name === "ServiceError" && typeof (err as any).status === "number") ||
    (typeof err === "object" && err !== null && "status" in err && typeof (err as any).status === "number" && "message" in err);

  if (isServiceError) {
    const serviceErr = err as ServiceError;
    return res.status(serviceErr.status).json({
      error: serviceErr.message,
      ...(serviceErr.details !== undefined ? { details: serviceErr.details } : {}),
    });
  }

  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  return res.status(500).json({ error: "Internal server error" });
}
