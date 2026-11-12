import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ServiceError } from "../services/ServiceError.js";
import * as notificationService from "../services/notificationService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export const listNotifications = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const callerRole = String(req.user?.role || "").toUpperCase();
  // Search, sort and paging are for staff bells; a customer always gets every row.
  const query = callerRole === "CUSTOMER" ? null : notificationService.parseListQuery(req.query as Record<string, unknown>);
  const { items, total } = await notificationService.listForCaller({ id: req.user!.id, role: callerRole }, query);
  // The body stays a bare array so older clients keep working; the page's total
  // rides in a header (exposed in CORS, the portal is cross-origin).
  if (total !== undefined) res.setHeader("X-Total-Count", String(total));
  res.json(items);
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

export const markAllNotificationsRead = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const callerRole = String(req.user?.role || "").toUpperCase();
  const result = await notificationService.markAllAsRead({ id: req.user!.id, role: callerRole });
  res.json({ success: true, count: result.count });
});

