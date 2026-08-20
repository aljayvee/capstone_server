import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ServiceError } from "../services/ServiceError.js";
import * as notificationService from "../services/notificationService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export const listNotifications = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const callerRole = String(req.user?.role || "").toUpperCase();
  const notifications = await notificationService.listForCaller({ id: req.user!.id, role: callerRole });
  res.json(notifications);
});

export const markNotificationRead = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    throw new ServiceError(400, "Invalid notification ID");
  }
  const callerRole = String(req.user?.role || "").toUpperCase();
  const notification = await notificationService.markAsRead(id, { id: req.user!.id, role: callerRole });
  res.json(notification);
});
