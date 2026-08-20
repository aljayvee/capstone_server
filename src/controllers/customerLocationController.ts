import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { locationSchema } from "../validators/locationValidators.js";
import * as locationService from "../services/locationService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";

export const listLocations = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const customerId = parseInt(req.params.userId, 10);
  if (isNaN(customerId)) {
    throw new ServiceError(400, "Invalid customer ID.");
  }

  const callerRole = String(req.user?.role || "").toUpperCase();
  if (callerRole === "CUSTOMER" && req.user?.id !== customerId) {
    throw new ServiceError(403, "Access denied: You can only view your own saved locations.");
  }

  const locations = await locationService.listLocations(customerId);
  res.json(locations);
});

export const createLocation = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const customerId = parseInt(String(body.userId ?? req.user?.id), 10);

  if (req.user?.id !== customerId) {
    throw new ServiceError(403, "Access denied: You can only add locations to your own account.");
  }

  const input = parseOrThrow(locationSchema, req.body);
  const location = await locationService.createLocation(customerId, input);
  res.status(201).json(location);
});

export const updateLocation = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    throw new ServiceError(400, "Invalid location ID.");
  }

  const existing = await locationService.getLocationOwner(id);
  if (existing.customerId !== req.user?.id) {
    throw new ServiceError(403, "Access denied: You can only edit your own locations.");
  }

  const input = parseOrThrow(locationSchema, req.body);
  const updated = await locationService.updateLocation(id, existing.customerId, input);
  res.json(updated);
});

export const deleteLocation = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    throw new ServiceError(400, "Invalid location ID.");
  }

  const existing = await locationService.getLocationOwner(id);
  if (existing.customerId !== req.user?.id) {
    throw new ServiceError(403, "Access denied: You can only delete your own locations.");
  }

  await locationService.deleteLocation(id, existing.isDefault, existing.customerId);
  res.json({ success: true });
});
