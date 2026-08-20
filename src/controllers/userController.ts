import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { createUserSchema, updateUserSchema, profileUpdateSchema } from "../validators/userValidators.js";
import * as userService from "../services/userService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { ServiceError } from "../services/ServiceError.js";

export const listUsers = asyncHandler(async (req, res) => {
  const users = await userService.listUsers();
  res.json(users);
});

export const createUser = asyncHandler(async (req, res) => {
  const input = parseOrThrow(createUserSchema, req.body);
  const user = await userService.createUser(input);
  res.status(201).json(user);
});

export const updateUser = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) {
    throw new ServiceError(400, "Invalid user ID");
  }
  const input = parseOrThrow(updateUserSchema, req.body);
  const user = await userService.updateUser(userId, input, req.user?.id);
  res.status(200).json(user);
});

export const updateProfile = asyncHandler<AuthenticatedRequest>(async (req, res: Response) => {
  const targetUserId = parseInt(req.params.userId, 10);
  if (isNaN(targetUserId)) {
    throw new ServiceError(400, "Invalid user ID");
  }

  const callerRole = String(req.user?.role || "").toUpperCase();
  const callerId = req.user?.id;
  if (callerRole !== "OWNER" && callerId !== targetUserId) {
    throw new ServiceError(403, "Access denied: Users can only edit their own profile.");
  }

  const input = parseOrThrow(profileUpdateSchema, req.body);
  const user = await userService.updateProfile(targetUserId, input);
  res.status(200).json({ message: "Profile updated successfully", user });
});
